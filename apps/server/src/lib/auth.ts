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

/** `<memberId>.<expiresAtMs>.<hmac>` — stateless; the member is re-read (and must be active) on every request. */
export function createSession(memberId: string, password: string, now: Date): string {
  const payload = `${memberId}.${now.getTime() + SESSION_HOURS * 3_600_000}`;
  return `${payload}.${sign(payload, password)}`;
}

/** The member id of a valid, unexpired session, or undefined. */
export function verifySession(value: string | undefined, password: string, now: Date): string | undefined {
  const [memberId, expiresAt, signature, ...rest] = value?.split(".") ?? [];
  if (!memberId || !expiresAt || !signature || rest.length > 0) return undefined;
  if (!safeEqual(signature, sign(`${memberId}.${expiresAt}`, password))) return undefined;
  return Number(expiresAt) > now.getTime() ? memberId : undefined;
}
