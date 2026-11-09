import { describe, expect, it } from "vitest";
import { checkPassword, createSession, SESSION_HOURS, verifySession } from "./auth";

const password = "a-long-admin-password";
const now = new Date("2026-10-26T12:00:00Z");
const later = (hours: number) => new Date(now.getTime() + hours * 3_600_000);

describe("admin auth", () => {
  it("checks the password", () => {
    expect(checkPassword(password, password)).toBe(true);
    expect(checkPassword("wrong", password)).toBe(false);
  });

  it("carries the member id and rejects the session after it expires", () => {
    const session = createSession("member-1", password, now);
    expect(verifySession(session, password, later(1))).toBe("member-1");
    expect(verifySession(session, password, later(SESSION_HOURS + 1))).toBeUndefined();
  });

  it("rejects tampered sessions and sessions signed with another password", () => {
    const session = createSession("member-1", password, now);
    const [, expiresAt, signature] = session.split(".");
    expect(verifySession(`member-2.${expiresAt}.${signature}`, password, now)).toBeUndefined();
    expect(verifySession(`member-1.${later(100).getTime()}.${signature}`, password, now)).toBeUndefined();
    expect(verifySession(session, "another-password-123", now)).toBeUndefined();
    expect(verifySession(undefined, password, now)).toBeUndefined();
    expect(verifySession("garbage", password, now)).toBeUndefined();
    // The session format before members (`<expiresAt>.<hmac>`) no longer signs anyone in.
    expect(verifySession(`${later(1).getTime()}.${signature}`, password, now)).toBeUndefined();
  });
});
