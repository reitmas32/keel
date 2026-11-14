import { describe, expect, it } from "vitest";
import { createChannelAs, deleteChannelAs, setChannelEnabledAs } from "./admin";
import { recordCiResult, requestDeploy } from "./deploys";
import { loadEnv } from "./env";
import { handlers } from "./handlers";
import { formatMessage, maskUrl, parseChannelInput, parseEvents, signBody, WebhookNotifier } from "./notify";
import { addMember, apiRequest, createTestContext, SHA } from "./testing";

const SLACK = "https://hooks.slack.com/services/T000/B000/secretsecret";
const deployReq = { repo: "konectus-io/app", tag: "v1.0.0", sha: SHA, scope: "api-prod" };
const ciReq = { repo: "konectus-io/app", tag: "v1.0.0", sha: SHA, status: "success" as const };

/** A fetch that records what it was asked to send and answers with `status`. */
function fakeFetch(status = 200) {
  const calls: { url: string; headers: Record<string, string>; body: unknown; raw: string }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(init.body as string),
      raw: init.body as string,
    });
    if (status === 0) throw new TypeError(`fetch failed for ${url}`);
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const sample = {
  event: "deploy.deployed" as const,
  deploy: {
    id: "d1",
    repo: "konectus-io/app",
    tag: "v1.0.0",
    sha: SHA,
    scope: "api-prod",
    status: "deployed" as const,
    error: null,
    requestedBy: "ana",
  },
};

describe("notification channels", () => {
  it("sends nothing while no channel is configured", async () => {
    const { store } = await createTestContext();
    const { fn, calls } = fakeFetch();
    const notifier = new WebhookNotifier(store, {}, { fetch: fn });
    notifier.notify(sample);
    await notifier.flush();
    expect(calls).toEqual([]);
  });

  it("posts each kind in its own format and signs generic webhooks", async () => {
    const { store, clock } = await createTestContext();
    const admin = await addMember(store, clock.now(), { role: "admin" });
    const p = { member: admin, grants: [], maxRole: null, anonymousRole: null };
    await createChannelAs(store, p, { name: "slack", kind: "slack", url: SLACK }, clock.now());
    await createChannelAs(
      store,
      p,
      { name: "discord", kind: "discord", url: "https://discord.com/api/webhooks/1/abc" },
      clock.now(),
    );
    await createChannelAs(
      store,
      p,
      { name: "hook", kind: "webhook", url: "http://internal.example/hook", secret: "s3cret" },
      clock.now(),
    );
    const { fn, calls } = fakeFetch();
    const notifier = new WebhookNotifier(store, { KEEL_PUBLIC_URL: "https://keel.example.com/" }, { fetch: fn });
    notifier.notify(sample);
    await notifier.flush();

    const byUrl = new Map(calls.map((c) => [c.url, c]));
    expect(byUrl.get(SLACK)?.body).toEqual({ text: expect.stringContaining("konectus-io/app v1.0.0 → api-prod") });
    expect(JSON.stringify(byUrl.get(SLACK)?.body)).toMatch(/https:\/\/keel\.example\.com\/apps\/.+\/deploys/);
    expect(byUrl.get("https://discord.com/api/webhooks/1/abc")?.body).toEqual({ content: expect.any(String) });
    const hook = byUrl.get("http://internal.example/hook");
    expect(hook?.body).toMatchObject({ event: "deploy.deployed", deploy: { id: "d1", scope: "api-prod" } });
    expect(hook?.headers["x-keel-signature"]).toBe(signBody(hook?.raw as string, "s3cret"));
    expect(hook?.headers["x-keel-event"]).toBe("deploy.deployed");
  });

  it("filters by event, repo, scope and enabled, and sends once to a URL configured twice", async () => {
    const { store, clock } = await createTestContext();
    const admin = await addMember(store, clock.now(), { role: "admin" });
    const p = { member: admin, grants: [], maxRole: null, anonymousRole: null };
    const url = (n: string) => `https://example.com/${n}`;
    await createChannelAs(
      store,
      p,
      { name: "fails", kind: "webhook", url: url("fails"), events: ["deploy.failed"] },
      clock.now(),
    );
    await createChannelAs(store, p, { name: "other", kind: "webhook", url: url("other"), repo: "otra/*" }, clock.now());
    await createChannelAs(store, p, { name: "stg", kind: "webhook", url: url("stg"), scope: "*-stg" }, clock.now());
    const paused = await createChannelAs(store, p, { name: "off", kind: "webhook", url: url("off") }, clock.now());
    await setChannelEnabledAs(store, p, paused.id, false, clock.now());
    await createChannelAs(store, p, { name: "prod", kind: "webhook", url: url("prod"), scope: "*-prod" }, clock.now());
    await createChannelAs(store, p, { name: "dup", kind: "slack", url: SLACK }, clock.now());

    const { fn, calls } = fakeFetch();
    const notifier = new WebhookNotifier(store, { KEEL_SLACK_WEBHOOK_URL: SLACK }, { fetch: fn });
    notifier.notify(sample);
    await notifier.flush();
    expect(calls.map((c) => c.url).sort()).toEqual([url("prod"), SLACK].sort());
  });

  it("limits environment channels to KEEL_NOTIFY_EVENTS", async () => {
    const { store } = await createTestContext();
    const { fn, calls } = fakeFetch();
    const notifier = new WebhookNotifier(
      store,
      { KEEL_WEBHOOK_URL: "https://example.com/env", KEEL_NOTIFY_EVENTS: "deploy.failed" },
      { fetch: fn },
    );
    notifier.notify(sample);
    notifier.notify({ ...sample, event: "deploy.failed" });
    await notifier.flush();
    expect(calls.map((c) => (c.body as { event: string }).event)).toEqual(["deploy.failed"]);
  });

  it("never throws when a webhook fails, times out or answers an error", async () => {
    const { store } = await createTestContext();
    for (const status of [0, 500]) {
      const { fn } = fakeFetch(status);
      const notifier = new WebhookNotifier(store, { KEEL_WEBHOOK_URL: "https://example.com/env" }, { fetch: fn });
      expect(() => notifier.notify(sample)).not.toThrow();
      await notifier.flush();
    }
  });

  it("keeps webhook URLs out of the audit log", async () => {
    const { store, clock } = await createTestContext();
    const admin = await addMember(store, clock.now(), { role: "admin" });
    const p = { member: admin, grants: [], maxRole: null, anonymousRole: null };
    const channel = await createChannelAs(store, p, { name: "slack", kind: "slack", url: SLACK }, clock.now());
    await deleteChannelAs(store, p, channel.id, clock.now());
    const audit = JSON.stringify(await store.listAudit());
    expect(audit).toContain("channel.create");
    expect(audit).toContain("channel.delete");
    expect(audit).not.toContain("secretsecret");
    expect(maskUrl(SLACK)).toBe("https://hooks.slack.com/…cret");
  });

  it("only lets global admins manage channels", async () => {
    const { store, clock } = await createTestContext();
    const maintainer = await addMember(store, clock.now(), { role: "maintainer" });
    const p = { member: maintainer, grants: [], maxRole: null, anonymousRole: null };
    await expect(createChannelAs(store, p, { name: "x", kind: "slack", url: SLACK }, clock.now())).rejects.toThrow(
      /no permite configurar notificaciones/,
    );
  });

  it("validates channels and events", () => {
    expect(() => parseChannelInput({ name: "", kind: "slack", url: SLACK })).toThrow(/nombre/);
    expect(() => parseChannelInput({ name: "x", kind: "email", url: SLACK })).toThrow(/Tipo/);
    expect(() => parseChannelInput({ name: "x", kind: "slack", url: "http://hooks.slack.com/x" })).toThrow(/https/);
    expect(() => parseChannelInput({ name: "x", kind: "slack", url: "nope" })).toThrow(/válida/);
    expect(() => parseEvents("deploy.nope")).toThrow(/desconocido/);
    expect(parseEvents("")).toEqual(["*"]);
    expect(parseEvents("deploy.failed, deploy.expired")).toEqual(["deploy.failed", "deploy.expired"]);
    // A secret only makes sense for a generic webhook.
    expect(parseChannelInput({ name: "x", kind: "slack", url: SLACK, secret: "s" }).secret).toBeNull();
  });

  it("rejects webhook URLs in the environment without echoing them", () => {
    const base = { DOKPLOY_URL: "https://d.example.com", DOKPLOY_API_KEY: "k", KEEL_ADMIN_PASSWORD: "x".repeat(12) };
    expect(loadEnv({ ...base, KEEL_SLACK_WEBHOOK_URL: SLACK }).KEEL_SLACK_WEBHOOK_URL).toBe(SLACK);
    expect(loadEnv({ ...base, KEEL_SLACK_WEBHOOK_URL: "" }).KEEL_SLACK_WEBHOOK_URL).toBeUndefined();
    let message = "";
    try {
      loadEnv({ ...base, KEEL_WEBHOOK_URL: "ftp://token-secreto@example.com" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/KEEL_WEBHOOK_URL/);
    expect(message).not.toContain("token-secreto");
  });

  it("writes the failure reason in the message", () => {
    const text = formatMessage({
      event: "deploy.failed",
      deploy: { ...sample.deploy, status: "deploy_failed", error: "pull access denied" },
    });
    expect(text).toContain("falló");
    expect(text).toContain("pull access denied");
  });
});

describe("deploy notifications", () => {
  it("announces deployed, failed and expired deploys from the worker", async () => {
    const { store, worker, dokploy, notifier, clock, ciToken } = await createTestContext();
    await recordCiResult(store, ciReq, ciToken, clock.now());
    await requestDeploy(store, deployReq, clock.now());
    await worker.tick();
    expect(notifier.events).toEqual([]);
    dokploy.status = "done";
    await worker.tick();
    expect(notifier.events).toEqual(["deploy.deployed"]);

    await requestDeploy(store, { ...deployReq, tag: "v1.0.1" }, clock.now());
    dokploy.status = "error";
    await worker.tick();
    await worker.tick();
    expect(notifier.events).toEqual(["deploy.deployed", "deploy.failed"]);

    await requestDeploy(store, { ...deployReq, tag: "v2.0.0", sha: "b".repeat(40) }, clock.now());
    clock.advanceMinutes(61);
    await worker.tick();
    expect(notifier.events).toEqual(["deploy.deployed", "deploy.failed", "deploy.expired"]);
  });

  it("announces a failed CI once per waiting deploy", async () => {
    const { ctx, store, notifier, clock, ciToken } = await createTestContext();
    await requestDeploy(store, deployReq, clock.now());
    const response = await handlers.ciResult(
      ctx,
      apiRequest("/ci-result", {
        method: "POST",
        body: { ...ciReq, status: "failure" },
        headers: { authorization: `Bearer ${ciToken}` },
      }),
    );
    expect(response.status).toBe(200);
    expect(notifier.events).toEqual(["deploy.ci_failed"]);
  });
});
