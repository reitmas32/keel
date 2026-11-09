import type { AppContext } from "./context";
import { ApiError } from "./errors";
import type { ApiToken, Store } from "./store";
import { bearerToken, generateApiToken, hashToken } from "./tokens";

/** Who is calling the API: the API token's name, or null when the call carried no token. */
export interface Caller {
  name: string | null;
}

export const API_TOKEN_NAME_MAX = 100;

/** `last_used_at` is written at most this often per token, so busy CLIs don't write on every call. */
const TOUCH_INTERVAL_MS = 60_000;

const HOW_TO_LOGIN = 'Crea un token en el admin de keel, en "Tokens de API", y ejecuta `keel login --token <token>`.';

/**
 * Resolves the caller of an `/api` route from `Authorization: Bearer <token>`. A token that is sent must be
 * valid; no token is allowed only while `KEEL_API_AUTH` is `optional`.
 */
export async function authenticate(ctx: AppContext, request: Request): Promise<Caller> {
  const header = request.headers.get("authorization");
  if (!header?.trim()) {
    if (ctx.env.KEEL_API_AUTH === "required") {
      throw new ApiError(401, `Esta instancia de keel pide un token de API. ${HOW_TO_LOGIN}`);
    }
    return { name: null };
  }

  const token = bearerToken(header);
  const record = token ? await ctx.store.getApiTokenByHash(hashToken(token)) : undefined;
  if (!record) throw new ApiError(401, `Token de API inválido o revocado. ${HOW_TO_LOGIN}`);

  const now = ctx.now();
  if (!record.lastUsedAt || now.getTime() - new Date(record.lastUsedAt).getTime() >= TOUCH_INTERVAL_MS) {
    await ctx.store.touchApiToken(record.id, now);
  }
  return { name: record.name };
}

/** Creates a personal API token and returns its plaintext, which is shown only once. */
export async function createApiToken(
  store: Store,
  rawName: string,
  now: Date,
): Promise<{ record: ApiToken; token: string }> {
  const name = rawName.trim();
  if (!name) throw new ApiError(400, "Ponle un nombre al token, p.ej. tu nombre o el de la máquina.");
  if (name.length > API_TOKEN_NAME_MAX) {
    throw new ApiError(400, `El nombre del token puede tener hasta ${API_TOKEN_NAME_MAX} caracteres.`);
  }
  // The name identifies who asked for a deploy, so two tokens can't share it.
  if (await store.getApiTokenByName(name)) throw new ApiError(409, `Ya existe un token llamado ${name}.`);
  const { token, hash } = generateApiToken();
  return { record: await store.createApiToken({ name, tokenHash: hash }, now), token };
}
