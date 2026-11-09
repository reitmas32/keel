import { type AnonymousRole, type Role, roleAtLeast } from "@keel/shared";
import type { Principal } from "./access";
import type { AppContext } from "./context";
import { ApiError } from "./errors";
import { BOOTSTRAP_ADMIN } from "./postgres-schema.mjs";
import type { ApiToken, Member, Store } from "./store";
import { bearerToken, generateApiToken, hashToken } from "./tokens";

/** Who is calling the API: a member through one of its tokens, or nobody (anonymous, only with auth optional). */
export interface Caller extends Principal {
  /**
   * What deploys and locks record as who asked: the member's name, or the token's name for tokens of the bootstrap
   * admin (the tokens created before members, named after their person). Null without a token.
   */
  name: string | null;
  tokenName: string | null;
}

export const API_TOKEN_NAME_MAX = 100;

/** `last_used_at` is written at most this often per token, so busy CLIs don't write on every call. */
const TOUCH_INTERVAL_MS = 60_000;

const HOW_TO_LOGIN = 'Crea un token en el admin de keel, en "Tokens de API", y ejecuta `keel login --token <token>`.';

/** The role of calls without a token; `none` can't do anything that needs a role. */
export const anonymousRole = (ctx: AppContext): Role | null => {
  const role: AnonymousRole = ctx.env.KEEL_ANONYMOUS_ROLE ?? "deployer";
  return role === "none" ? null : role;
};

/**
 * Resolves the caller of an `/api` route from `Authorization: Bearer <token>`. A token that is sent must be
 * valid and its owner active; no token is allowed only while `KEEL_API_AUTH` is `optional`.
 */
export async function authenticate(ctx: AppContext, request: Request): Promise<Caller> {
  const header = request.headers.get("authorization");
  if (!header?.trim()) {
    if (ctx.env.KEEL_API_AUTH === "required") {
      throw new ApiError(401, `Esta instancia de keel pide un token de API. ${HOW_TO_LOGIN}`);
    }
    return { name: null, tokenName: null, member: null, grants: [], maxRole: null, anonymousRole: anonymousRole(ctx) };
  }

  const token = bearerToken(header);
  const record = token ? await ctx.store.getApiTokenByHash(hashToken(token)) : undefined;
  if (!record) throw new ApiError(401, `Token de API inválido o revocado. ${HOW_TO_LOGIN}`);
  const member = record.memberId ? await ctx.store.getMember(record.memberId) : undefined;
  if (member?.status !== "active") {
    throw new ApiError(
      401,
      "El miembro dueño de este token está deshabilitado. Pide a un admin de keel que lo reactive.",
    );
  }

  const now = ctx.now();
  if (!record.lastUsedAt || now.getTime() - new Date(record.lastUsedAt).getTime() >= TOUCH_INTERVAL_MS) {
    await ctx.store.touchApiToken(record.id, now);
  }
  return {
    name: member.id === BOOTSTRAP_ADMIN.id ? record.name : member.name,
    tokenName: record.name,
    member,
    grants: await ctx.store.listGrants(member.id),
    maxRole: record.maxRole,
    anonymousRole: null,
  };
}

/**
 * Creates a personal API token for `owner` and returns its plaintext, which is shown only once. `maxRole` caps the
 * token below the owner's role; it can't be above it.
 */
export async function createApiToken(
  store: Store,
  input: { name: string; owner: Member; maxRole?: Role | null },
  now: Date,
): Promise<{ record: ApiToken; token: string }> {
  const name = input.name.trim();
  if (!name) throw new ApiError(400, "Ponle un nombre al token, p.ej. tu nombre o el de la máquina.");
  if (name.length > API_TOKEN_NAME_MAX) {
    throw new ApiError(400, `El nombre del token puede tener hasta ${API_TOKEN_NAME_MAX} caracteres.`);
  }
  const maxRole = input.maxRole ?? null;
  if (maxRole && !roleAtLeast(input.owner.role, maxRole)) {
    throw new ApiError(400, `El rol máximo (${maxRole}) no puede estar por encima de tu rol (${input.owner.role}).`);
  }
  // The name identifies who asked for a deploy, so two tokens can't share it.
  if (await store.getApiTokenByName(name)) throw new ApiError(409, `Ya existe un token llamado ${name}.`);
  const { token, hash } = generateApiToken();
  return {
    record: await store.createApiToken({ name, tokenHash: hash, memberId: input.owner.id, maxRole }, now),
    token,
  };
}
