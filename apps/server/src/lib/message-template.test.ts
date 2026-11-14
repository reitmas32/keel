import { describe, expect, it } from "vitest";
import { createChannelAs, updateChannelAs } from "./admin";
import { defaultMessage, renderMessage, SAMPLE_MESSAGE } from "./message-template";
import { envChannels, parseChannelInput, WebhookNotifier } from "./notify";
import { addMember, createTestContext, SHA } from "./testing";

const SLACK = "https://hooks.slack.com/services/T000/B000/xxxxxxxx";

describe("message templates", () => {
  it("is keel's own message without a template", () => {
    expect(renderMessage(null, SAMPLE_MESSAGE)).toBe(defaultMessage(SAMPLE_MESSAGE));
    expect(renderMessage("   ", SAMPLE_MESSAGE)).toBe(defaultMessage(SAMPLE_MESSAGE));
  });

  it("fills the variables, drops lines left empty and keeps unknown names as written", () => {
    const approved = { ...SAMPLE_MESSAGE, event: "deploy.approved" as const, error: null, actor: "ana", link: null };
    expect(renderMessage("*{repo}* {tag} → {scope} ({sha})\n{error}\npor {actor} {unknown}\n{link}", approved)).toBe(
      "*fundathyon/core-api* v2.4.1 → api-prod (3f9c2a1)\npor ana {unknown}",
    );
    expect(renderMessage("<!here> {message}", SAMPLE_MESSAGE)).toBe(`<!here> ${defaultMessage(SAMPLE_MESSAGE)}`);
  });

  it("sends each channel its own message, and the environment's template to its channels", async () => {
    const { store, clock } = await createTestContext();
    const admin = await addMember(store, clock.now(), { role: "admin" });
    const p = { member: admin, grants: [], maxRole: null, anonymousRole: null };
    const channel = await createChannelAs(
      store,
      p,
      { name: "slack", kind: "slack", url: SLACK, template: "{icon} {tag} en {scope}" },
      clock.now(),
    );
    expect(channel.template).toBe("{icon} {tag} en {scope}");

    const bodies: unknown[] = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const env = {
      KEEL_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/x",
      KEEL_NOTIFY_TEMPLATE: "{tag} listo",
    };
    expect(envChannels(env)[0]?.template).toBe("{tag} listo");
    const notifier = new WebhookNotifier(store, env, { fetch: fetchFn });
    notifier.notify({
      event: "deploy.deployed",
      deploy: {
        id: "d",
        repo: "konectus-io/app",
        tag: "v1.0.0",
        sha: SHA,
        scope: "api-prod",
        status: "deployed",
        error: null,
        requestedBy: "ana",
      },
    });
    await notifier.flush();
    expect(bodies).toEqual(expect.arrayContaining([{ text: "✅ v1.0.0 en api-prod" }, { content: "v1.0.0 listo" }]));

    // An empty template on edit goes back to keel's message.
    const back = await updateChannelAs(
      store,
      p,
      channel.id,
      { name: "slack", kind: "slack", url: "", template: "" },
      clock.now(),
    );
    expect(back.template).toBeNull();
  });

  it("refuses a template longer than 1000 characters", () => {
    expect(() => parseChannelInput({ name: "x", kind: "slack", url: SLACK, template: "x".repeat(1001) })).toThrow(
      /1000/,
    );
  });
});
