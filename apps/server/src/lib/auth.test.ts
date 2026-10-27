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

  it("accepts a fresh session and rejects it after it expires", () => {
    const session = createSession(password, now);
    expect(verifySession(session, password, later(1))).toBe(true);
    expect(verifySession(session, password, later(SESSION_HOURS + 1))).toBe(false);
  });

  it("rejects tampered sessions and sessions signed with another password", () => {
    const session = createSession(password, now);
    const [, signature] = session.split(".");
    expect(verifySession(`${later(100).getTime()}.${signature}`, password, now)).toBe(false);
    expect(verifySession(session, "another-password-123", now)).toBe(false);
    expect(verifySession(undefined, password, now)).toBe(false);
    expect(verifySession("garbage", password, now)).toBe(false);
  });
});
