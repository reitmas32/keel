import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "keel_admin";
export const SESSION_HOURS = 12;

// Derived from the admin password, so changing KEEL_ADMIN_PASSWORD invalidates every session.
const sessionKey = (password: string) => createHash("sha256").update(`keel-admin-session:${password}`).digest();

const sign = (payload: string, password: string) =>
  createHmac("sha256", sessionKey(password)).update(payload).digest("base64url");

const safeEqual = (a: string, b: string) => {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
};

export function checkPassword(input: string, password: string): boolean {
  return safeEqual(input, password);
}

/** `<expiresAtMs>.<hmac>` — stateless, nothing to store server-side. */
export function createSession(password: string, now: Date): string {
  const expiresAt = String(now.getTime() + SESSION_HOURS * 3_600_000);
  return `${expiresAt}.${sign(expiresAt, password)}`;
}

export function verifySession(value: string | undefined, password: string, now: Date): boolean {
  if (!value) return false;
  const [expiresAt, signature] = value.split(".");
  if (!expiresAt || !signature || !safeEqual(signature, sign(expiresAt, password))) return false;
  return Number(expiresAt) > now.getTime();
}
