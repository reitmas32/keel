import { randomBytes, type ScryptOptions, scrypt, timingSafeEqual } from "node:crypto";

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 200;

const KEY_LENGTH = 64;
const PARAMS = { N: 16_384, r: 8, p: 1 };

const derive = (password: string, salt: Buffer, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => {
    scrypt(password.normalize("NFC"), salt, KEY_LENGTH, { ...options, maxmem: 64 * 1024 * 1024 }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });

/** `scrypt$N$r$p$<salt>$<hash>` (base64url), with a fresh 16-byte salt per call. The password is never stored. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, PARAMS);
  return ["scrypt", PARAMS.N, PARAMS.r, PARAMS.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

/** Checks a password against a hash from hashPassword, in constant time. Anything malformed is false. */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored?.split("$") ?? [];
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  try {
    const actual = await derive(password, Buffer.from(salt, "base64url"), { N: Number(n), r: Number(r), p: Number(p) });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
