import { parseDokployServiceUrl } from "./dokploy";
import { ApiError } from "./errors";
import type { Scope, Service, Store } from "./store";
import { generateCiToken } from "./tokens";

/** Accepts `https://github.com/o/r(.git)`, `git@github.com:o/r.git` or `o/r` and returns `o/r`. */
export function parseGithubRepoUrl(input: string): string | undefined {
  const value = input.trim();
  const match =
    value.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i) ??
    value.match(/^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i) ??
    value.match(/^([\w.-]+)\/([\w.-]+)$/);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : undefined;
}

/** Creates a scope for a repo and returns the plaintext CI token, which is shown only once. */
export function createScope(store: Store, input: { name: string; repoUrl: string }, now: Date) {
  const repo = parseGithubRepoUrl(input.repoUrl);
  if (!repo) throw new ApiError(400, `URL de repo de GitHub inválida: ${input.repoUrl}`);
  if (store.getScopeByRepo(repo)) throw new ApiError(409, `El repo ${repo} ya está vinculado a un scope.`);
  const { token, hash } = generateCiToken();
  const scope = store.createScope({ name: input.name.trim() || repo, repo, ciTokenHash: hash }, now);
  return { scope, ciToken: token };
}

export function rotateCiToken(store: Store, scopeId: string): string {
  if (!store.getScope(scopeId)) throw new ApiError(404, "Scope no encontrado.");
  const { token, hash } = generateCiToken();
  store.setCiTokenHash(scopeId, hash);
  return token;
}

const ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function addService(
  store: Store,
  scope: Scope,
  input: { alias: string; dokployUrl: string },
  now: Date,
): Service {
  const alias = input.alias.trim().toLowerCase();
  if (!ALIAS_PATTERN.test(alias)) {
    throw new ApiError(400, "El alias solo puede tener minúsculas, números y guiones (p.ej. api-prod).");
  }
  const parsed = parseDokployServiceUrl(input.dokployUrl);
  if (!parsed) {
    throw new ApiError(
      400,
      "URL de servicio de Dokploy inválida. Copia la URL del servicio desde el dashboard (…/services/application/<id>).",
    );
  }
  if (parsed.kind !== "application") {
    throw new ApiError(400, "Por ahora keel solo soporta servicios de tipo Application (no Compose).");
  }
  if (store.getServiceByAlias(scope.id, alias)) {
    throw new ApiError(409, `Ya existe un servicio con alias ${alias} en ${scope.repo}.`);
  }
  return store.addService(
    { scopeId: scope.id, alias, dokployUrl: input.dokployUrl.trim(), kind: parsed.kind, dokployId: parsed.id },
    now,
  );
}
