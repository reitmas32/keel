import { createPublicKey, type JsonWebKeyInput, type KeyObject, verify } from "node:crypto";
import type { Env } from "./env";

/**
 * Login through a Foundathyon Accounts instance, the same way Helm does: email + password (`/emails/signin`) or a
 * code sent by email (`/emails/email-code/request` and `/claim`), with the app's publishable key. Accounts only says
 * who someone is; whether they can enter and what they can do stays in keel (members, roles, grants).
 */
export interface AccountsConfig {
  /** Base URL with its ROOT_PATH, e.g. http://prod-helm-accounts-api:8000/accounts. */
  url: string;
  /** The app's publishable key (pk_…). */
  publishableKey: string;
  /** The app's id: the audience of its access tokens. */
  appId: string;
  /** The `iss` Accounts signs with. */
  issuer: string;
}

export function accountsConfig(env: Partial<Env>): AccountsConfig | null {
  if (!env.ACCOUNTS_URL || !env.ACCOUNTS_PUBLISHABLE_KEY || !env.ACCOUNTS_APP_ID) return null;
  return {
    url: env.ACCOUNTS_URL.replace(/\/+$/, ""),
    publishableKey: env.ACCOUNTS_PUBLISHABLE_KEY,
    appId: env.ACCOUNTS_APP_ID,
    issuer: env.ACCOUNTS_ISSUER ?? "foundathyon-accounts",
  };
}

/** Why a step failed, as the login page needs it. `unavailable`: Accounts can't be reached or answered 5xx. */
export type AccountsFailureReason =
  | "invalid_credentials"
  | "invalid_code"
  | "needs_new_code"
  | "try_later"
  | "disabled"
  | "mfa"
  | "unavailable"
  | "rejected";

export type AccountsFailure = { ok: false; reason: AccountsFailureReason; remainingAttempts?: number };

/** Who Accounts says signed in: the token's subject and the account's email. */
export interface AccountsIdentity {
  ok: true;
  userId: string;
  email: string;
}

export interface AccountsClient {
  signIn(email: string, password: string): Promise<AccountsIdentity | AccountsFailure>;
  requestEmailCode(email: string): Promise<{ ok: true; challengeId: string; expiresIn: number } | AccountsFailure>;
  claimEmailCode(challengeId: string, code: string): Promise<AccountsIdentity | AccountsFailure>;
}

const NEEDS_NEW_CODE = new Set([
  "email_code.attempts_exceeded",
  "email_code.expired",
  "email_code.superseded",
  "email_code.already_used",
  "email_code.binding_mismatch",
]);
const TRY_LATER = new Set(["email_code.cooldown", "email_code.rate_limit_exceeded", "auth.rate_limited"]);

export function classifyScope(status: number, scope: string | undefined): AccountsFailureReason {
  if (status === 0 || status >= 500) return "unavailable";
  if (scope === "emails.signin.invalid_credentials") return "invalid_credentials";
  if (scope === "email_code.invalid") return "invalid_code";
  if (scope === "email_code.disabled") return "disabled";
  if (scope && NEEDS_NEW_CODE.has(scope)) return "needs_new_code";
  if (scope && TRY_LATER.has(scope)) return "try_later";
  if (status === 401) return "invalid_credentials";
  return "rejected";
}

type Envelope<T> = { data?: T; error?: { scope?: string; meta?: { remaining_attempts?: number } } };
type LoginData = {
  access_token?: string;
  jwt?: string;
  user?: { id?: string; email?: string };
  mfa_required?: boolean;
  mfa_enrollment_required?: boolean;
};

const TIMEOUT_MS = 8_000;

// --- access token verification (RS256 against the app's JWKS) ---

const b64json = (part: string) =>
  JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;

/**
 * The app's signing keys by `kid`, fetched from `/api/v1/jwks/{appId}`. An unknown `kid` (a rotated key) fetches the
 * set again, at most once a minute.
 */
export class JwksCache {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = 0;

  constructor(
    private readonly url: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async key(kid: string): Promise<KeyObject | undefined> {
    if (!this.keys.has(kid) && this.now() - this.fetchedAt > 60_000) await this.refresh();
    return this.keys.get(kid);
  }

  private async refresh(): Promise<void> {
    this.fetchedAt = this.now();
    const response = await this.fetcher(this.url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) throw new Error(`JWKS respondió ${response.status}`);
    const body = (await response.json()) as { keys?: (JsonWebKeyInput["key"] & { kid?: string; kty?: string })[] };
    const keys = new Map<string, KeyObject>();
    for (const jwk of body.keys ?? []) {
      if (jwk.kid && jwk.kty === "RSA") keys.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
    }
    this.keys = keys;
  }
}

/**
 * The subject of an Accounts access token if it is signed with one of the app's keys (RS256), typed `at+jwt`, issued
 * by `issuer` for `appId` and not expired; otherwise undefined.
 */
export async function verifyAccessToken(
  token: string,
  jwks: Pick<JwksCache, "key">,
  expected: { issuer: string; appId: string },
  nowSeconds: number,
): Promise<{ sub: string } | undefined> {
  const [headerPart, payloadPart, signaturePart, ...rest] = token.split(".");
  if (!headerPart || !payloadPart || !signaturePart || rest.length > 0) return undefined;
  try {
    const header = b64json(headerPart);
    if (header.alg !== "RS256" || typeof header.kid !== "string") return undefined;
    if (typeof header.typ === "string" && header.typ.toLowerCase() !== "at+jwt") return undefined;
    const key = await jwks.key(header.kid);
    if (!key) return undefined;
    const valid = verify(
      "RSA-SHA256",
      Buffer.from(`${headerPart}.${payloadPart}`),
      key,
      Buffer.from(signaturePart, "base64url"),
    );
    if (!valid) return undefined;
    const claims = b64json(payloadPart);
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== expected.issuer || !audience.includes(expected.appId)) return undefined;
    if (typeof claims.exp !== "number" || claims.exp <= nowSeconds) return undefined;
    if (typeof claims.nbf === "number" && claims.nbf > nowSeconds + 60) return undefined;
    if (typeof claims.sub !== "string" || !claims.sub) return undefined;
    return { sub: claims.sub };
  } catch {
    return undefined;
  }
}

/** The real client over HTTP. `fetch` is injectable for tests. */
export class HttpAccountsClient implements AccountsClient {
  private readonly jwks: JwksCache;

  constructor(
    private readonly config: AccountsConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.jwks = new JwksCache(`${config.url}/api/v1/jwks/${encodeURIComponent(config.appId)}`, fetcher);
  }

  private async call<T>(path: string, body: unknown): Promise<{ ok: true; data: T } | AccountsFailure> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.config.url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": this.config.publishableKey, "x-caller-id": "keel" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return { ok: false, reason: "unavailable" };
    }
    let envelope: Envelope<T> | null = null;
    try {
      envelope = (await response.json()) as Envelope<T>;
    } catch {
      // Accounts always answers JSON; anything else is a proxy or network error.
    }
    if (!response.ok || !envelope?.data) {
      const remaining = envelope?.error?.meta?.remaining_attempts;
      return {
        ok: false,
        reason: classifyScope(response.status, envelope?.error?.scope),
        ...(typeof remaining === "number" && { remainingAttempts: remaining }),
      };
    }
    return { ok: true, data: envelope.data };
  }

  /** Checks the tokens of a login answer and returns who it is. `fallbackEmail` only when Accounts doesn't say it. */
  private async identity(data: LoginData, fallbackEmail?: string): Promise<AccountsIdentity | AccountsFailure> {
    if (data.mfa_required || data.mfa_enrollment_required) return { ok: false, reason: "mfa" };
    const token = data.access_token ?? data.jwt;
    if (!token) return { ok: false, reason: "rejected" };
    let claims: { sub: string } | undefined;
    try {
      claims = await verifyAccessToken(token, this.jwks, this.config, Math.floor(Date.now() / 1000));
    } catch {
      return { ok: false, reason: "unavailable" };
    }
    if (!claims || (data.user?.id && data.user.id !== claims.sub)) return { ok: false, reason: "rejected" };
    const email = (data.user?.email ?? fallbackEmail)?.trim().toLowerCase();
    if (!email) return { ok: false, reason: "rejected" };
    return { ok: true, userId: claims.sub, email };
  }

  async signIn(email: string, password: string) {
    const result = await this.call<LoginData>("/api/v1/emails/signin", { email, password });
    if (!result.ok) return result;
    // A password sign-in proves the email it was made with.
    return this.identity(result.data, email);
  }

  async requestEmailCode(email: string) {
    const result = await this.call<{ challenge_id: string; expires_in: number }>("/api/v1/emails/email-code/request", {
      email,
      locale: "es",
    });
    if (!result.ok) return result;
    return { ok: true as const, challengeId: result.data.challenge_id, expiresIn: result.data.expires_in };
  }

  async claimEmailCode(challengeId: string, code: string) {
    const result = await this.call<LoginData>("/api/v1/emails/email-code/claim", { challenge_id: challengeId, code });
    if (!result.ok) return result;
    // Only the email Accounts reports counts: the one typed when asking for the code proves nothing.
    return this.identity(result.data);
  }
}
