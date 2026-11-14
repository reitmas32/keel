import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatLine, statusLevel } from "./log";
import { tracedFetch } from "./outbound";
import { maskEmail, REDACTED, redactBody, redactHeaders, redactPath, redactString, redactValue } from "./redact";
import { withRequestLog } from "./request-log";

// Real-looking secrets, as in Accounts' redaction test: each must never reach a line.
const SECRETS = {
  jwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  // Built here so the repo never holds a string shaped like a real Slack token.
  slack: ["xoxb", "1234567890", "0987654321", "AbCdEfGhIjKlMnOp"].join("-"),
  password: "hunter2-but-longer",
  dsn: "postgres://keel:supersecretpw@db.internal:5432/keel",
  apiKey: "dokploy_live_9f8e7d6c5b4a",
};

describe("redaction", () => {
  it("never lets a secret through a field, the message or a nested object, in either format", () => {
    const now = new Date("2026-11-14T00:00:00Z");
    const fields = {
      password: SECRETS.password,
      authorization: `Bearer ${SECRETS.jwt}`,
      apiKey: SECRETS.apiKey,
      note: `token=${SECRETS.slack} and ${SECRETS.dsn}`,
      nested: { deep: { secret: SECRETS.password, token: SECRETS.slack } },
      email: "rafael@example.com",
    };
    for (const as of ["json", "text"] as const) {
      const line = formatLine("error", `fallo con ${SECRETS.jwt} y ${SECRETS.dsn}`, fields, now, as);
      for (const secret of [SECRETS.jwt, SECRETS.slack, SECRETS.password, "supersecretpw", SECRETS.apiKey]) {
        expect(line).not.toContain(secret);
      }
      expect(line).toContain(REDACTED);
      expect(line).toContain("r***@example.com");
      expect(line).not.toContain("rafael@");
    }
  });

  it("keeps identifiers and harmless values readable", () => {
    expect(redactValue({ tokenId: "t1", channelId: "c1", status: 401, tag: "v1.2.3" })).toEqual({
      tokenId: "t1",
      channelId: "c1",
      status: 401,
      tag: "v1.2.3",
    });
    expect(redactString("postgres://keel:pw@db:5432/keel")).toBe(`postgres://keel:${REDACTED}@db:5432/keel`);
    expect(maskEmail("de ana@konectus.io para todos")).toBe("de a***@konectus.io para todos");
  });

  it("shows only allow-listed headers and query values, and trims bodies to 2 KB", () => {
    const headers = new Headers({ authorization: "Bearer x", "x-api-key": "k", "user-agent": "keel-cli/0.13" });
    expect(redactHeaders(headers)).toEqual({
      authorization: REDACTED,
      "x-api-key": REDACTED,
      "user-agent": "keel-cli/0.13",
    });
    expect(redactPath("/api/versions?repo=a/b&token=abc")).toBe(`/api/versions?repo=a/b&token=${REDACTED}`);
    expect(redactBody(JSON.stringify({ tag: "v1", password: "p" }))).toBe(`{"tag":"v1","password":"${REDACTED}"}`);
    expect(redactBody("x".repeat(5000)).length).toBeLessThan(2100);
  });
});

describe("request and dependency logs", () => {
  let lines: string[] = [];
  beforeEach(() => {
    lines = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
    vi.spyOn(console, "error").mockImplementation((line: string) => void lines.push(line));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.KEEL_LOG_LEVEL;
    delete process.env.KEEL_LOG_BODIES;
  });
  const parsed = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);

  it("logs each API request with its status, duration and request id, at the level of its status", async () => {
    const handler = withRequestLog(async (request: Request) =>
      request.headers.get("authorization")
        ? Response.json({ ok: true })
        : Response.json({ error: "Falta el token." }, { status: 401 }),
    );
    const denied = await handler(new Request("http://keel/api/deploys", { method: "POST" }));
    expect(denied.headers.get("x-request-id")).toMatch(/^[0-9a-f]{16}$/);
    await handler(
      new Request("http://keel/api/deploys", {
        method: "POST",
        headers: { authorization: "Bearer t", "x-request-id": "abc-1" },
      }),
    );
    const [first, second] = parsed();
    expect(first).toMatchObject({
      level: "warn",
      msg: "http.request.completed",
      status: 401,
      reason: "Falta el token.",
    });
    expect(second).toMatchObject({
      level: "info",
      status: 200,
      requestId: "abc-1",
      method: "POST",
      path: "/api/deploys",
    });
    expect(typeof second?.durationMs).toBe("number");
  });

  it("turns a handler that throws into a logged 500 with its stack, and keeps health checks quiet", async () => {
    const failing = withRequestLog(async (_request: Request): Promise<Response> => {
      throw new Error(`se rompió con ${SECRETS.dsn}`);
    });
    const response = await failing(new Request("http://keel/api/apps"));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ requestId: expect.any(String) });
    const [failed] = parsed();
    expect(failed).toMatchObject({ level: "error", msg: "http.request.failed", status: 500 });
    expect(failed?.stack).toBeInstanceOf(Array);
    expect(lines.join("\n")).not.toContain("supersecretpw");

    lines = [];
    await withRequestLog(async (_request: Request) => Response.json({ ok: true }))(
      new Request("http://keel/api/health"),
    );
    expect(lines).toEqual([]);
  });

  it("dumps redacted headers and bodies only with debug and KEEL_LOG_BODIES", async () => {
    const echo = withRequestLog(async (request: Request) =>
      Response.json({ got: await request.json(), token: "s3cr3t-token" }),
    );
    const call = () =>
      echo(
        new Request("http://keel/api/deploys", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer abc" },
          body: JSON.stringify({ tag: "v1.0.0", password: "p4ss" }),
        }),
      );
    await call();
    expect(parsed().map((l) => l.msg)).toEqual(["http.request.completed"]);

    lines = [];
    process.env.KEEL_LOG_LEVEL = "debug";
    process.env.KEEL_LOG_BODIES = "true";
    await call();
    const debug = parsed().find((l) => l.msg === "http.request.debug");
    expect(debug).toMatchObject({ headers: { authorization: REDACTED, "content-type": "application/json" } });
    expect(String(debug?.requestBody)).toContain("v1.0.0");
    expect(lines.join("\n")).not.toContain("p4ss");
    expect(lines.join("\n")).not.toContain("s3cr3t-token");
  });

  it("logs calls to dependencies: debug when they answer, warn/error when they fail", async () => {
    process.env.KEEL_LOG_LEVEL = "debug";
    const answering = (status: number) => (async () => new Response("{}", { status })) as unknown as typeof fetch;
    await tracedFetch("dokploy", answering(200))("https://dokploy.example.com/api/compose.one?composeId=x");
    await tracedFetch("accounts", answering(503))("https://accounts.example.com/api/v1/emails/email-code/request");
    const refused = (async () => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    }) as unknown as typeof fetch;
    await expect(tracedFetch("slack", refused)("https://slack.com/api/chat.postMessage")).rejects.toThrow();
    expect(parsed()).toMatchObject([
      {
        level: "debug",
        msg: "dependency.call",
        dependency: "dokploy",
        status: 200,
        target: "https://dokploy.example.com/api/compose.one",
      },
      { level: "error", msg: "dependency.failed", dependency: "accounts", status: 503 },
      { level: "error", msg: "dependency.failed", dependency: "slack", reason: "connection", cause: "ECONNREFUSED" },
    ]);
  });

  it("levels statuses like Accounts", () => {
    expect([200, 404, 401, 403, 429, 418, 502].map(statusLevel)).toEqual([
      "info",
      "info",
      "warn",
      "warn",
      "warn",
      "warn",
      "error",
    ]);
  });
});
