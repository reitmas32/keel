import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { type CiResultRequest, canTransition, type Deploy, type DeployStatus } from "@keel/shared";

export interface Scope {
  id: string;
  name: string;
  repo: string;
  createdAt: string;
}

export type ServiceKind = "application" | "compose";

export interface Service {
  id: string;
  scopeId: string;
  alias: string;
  dokployUrl: string;
  kind: ServiceKind;
  dokployId: string;
  createdAt: string;
}

export interface CiResult {
  repo: string;
  sha: string;
  tag: string;
  status: CiResultRequest["status"];
  receivedAt: string;
}

export interface DeployRecord extends Deploy {
  serviceId: string;
  deployStartedAt: string | null;
}

type Row = Record<string, unknown>;

const toScope = (r: Row): Scope => ({
  id: r.id as string,
  name: r.name as string,
  repo: r.repo as string,
  createdAt: r.created_at as string,
});

const toService = (r: Row): Service => ({
  id: r.id as string,
  scopeId: r.scope_id as string,
  alias: r.alias as string,
  dokployUrl: r.dokploy_url as string,
  kind: r.kind as ServiceKind,
  dokployId: r.dokploy_id as string,
  createdAt: r.created_at as string,
});

const toDeploy = (r: Row): DeployRecord => ({
  id: r.id as string,
  repo: r.repo as string,
  tag: r.tag as string,
  sha: r.sha as string,
  serviceId: r.service_id as string,
  service: r.service_alias as string,
  status: r.status as DeployStatus,
  error: (r.error as string | null) ?? null,
  deployStartedAt: (r.deploy_started_at as string | null) ?? null,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

/** `owner/name`, lowercased, so lookups ignore GitHub's case-insensitivity. */
export const normalizeRepo = (repo: string) => repo.trim().toLowerCase();

export class Store {
  constructor(private readonly db: DatabaseSync) {}

  // --- scopes ---

  createScope(input: { name: string; repo: string; ciTokenHash: string }, now: Date): Scope {
    const scope = { id: randomUUID(), name: input.name, repo: normalizeRepo(input.repo), createdAt: now.toISOString() };
    this.db
      .prepare("INSERT INTO scopes (id, name, repo, ci_token_hash, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(scope.id, scope.name, scope.repo, input.ciTokenHash, scope.createdAt);
    return scope;
  }

  listScopes(): Scope[] {
    return this.db.prepare("SELECT * FROM scopes ORDER BY name").all().map(toScope);
  }

  getScope(id: string): Scope | undefined {
    const row = this.db.prepare("SELECT * FROM scopes WHERE id = ?").get(id);
    return row ? toScope(row) : undefined;
  }

  getScopeByRepo(repo: string): Scope | undefined {
    const row = this.db.prepare("SELECT * FROM scopes WHERE repo = ?").get(normalizeRepo(repo));
    return row ? toScope(row) : undefined;
  }

  getCiTokenHash(scopeId: string): string | undefined {
    const row = this.db.prepare("SELECT ci_token_hash FROM scopes WHERE id = ?").get(scopeId);
    return row?.ci_token_hash as string | undefined;
  }

  setCiTokenHash(scopeId: string, hash: string): void {
    this.db.prepare("UPDATE scopes SET ci_token_hash = ? WHERE id = ?").run(hash, scopeId);
  }

  deleteScope(id: string): void {
    this.db.prepare("DELETE FROM scopes WHERE id = ?").run(id);
  }

  // --- services ---

  addService(input: Omit<Service, "id" | "createdAt">, now: Date): Service {
    const service: Service = { ...input, id: randomUUID(), createdAt: now.toISOString() };
    this.db
      .prepare(
        "INSERT INTO services (id, scope_id, alias, dokploy_url, kind, dokploy_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        service.id,
        service.scopeId,
        service.alias,
        service.dokployUrl,
        service.kind,
        service.dokployId,
        service.createdAt,
      );
    return service;
  }

  listServices(scopeId: string): Service[] {
    return this.db.prepare("SELECT * FROM services WHERE scope_id = ? ORDER BY alias").all(scopeId).map(toService);
  }

  getService(id: string): Service | undefined {
    const row = this.db.prepare("SELECT * FROM services WHERE id = ?").get(id);
    return row ? toService(row) : undefined;
  }

  getServiceByAlias(scopeId: string, alias: string): Service | undefined {
    const row = this.db.prepare("SELECT * FROM services WHERE scope_id = ? AND alias = ?").get(scopeId, alias);
    return row ? toService(row) : undefined;
  }

  deleteService(id: string): void {
    this.db.prepare("DELETE FROM services WHERE id = ?").run(id);
  }

  // --- CI results ---

  upsertCiResult(result: CiResult): void {
    this.db
      .prepare(
        `INSERT INTO ci_results (repo, sha, tag, status, received_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (repo, sha) DO UPDATE SET tag = excluded.tag, status = excluded.status, received_at = excluded.received_at`,
      )
      .run(normalizeRepo(result.repo), result.sha, result.tag, result.status, result.receivedAt);
  }

  getCiResult(repo: string, sha: string): CiResult | undefined {
    const row = this.db.prepare("SELECT * FROM ci_results WHERE repo = ? AND sha = ?").get(normalizeRepo(repo), sha);
    if (!row) return undefined;
    return {
      repo: row.repo as string,
      sha: row.sha as string,
      tag: row.tag as string,
      status: row.status as CiResult["status"],
      receivedAt: row.received_at as string,
    };
  }

  // --- deploys ---

  insertDeploy(
    input: { repo: string; tag: string; sha: string; service: Service; status: DeployStatus; error?: string },
    now: Date,
  ): DeployRecord {
    const id = randomUUID();
    const ts = now.toISOString();
    this.db
      .prepare(
        `INSERT INTO deploys (id, repo, tag, sha, service_id, service_alias, status, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        normalizeRepo(input.repo),
        input.tag,
        input.sha,
        input.service.id,
        input.service.alias,
        input.status,
        input.error ?? null,
        ts,
        ts,
      );
    return this.getDeploy(id) as DeployRecord;
  }

  getDeploy(id: string): DeployRecord | undefined {
    const row = this.db.prepare("SELECT * FROM deploys WHERE id = ?").get(id);
    return row ? toDeploy(row) : undefined;
  }

  /** Oldest first by default (queue order); pass `newestFirst` for history views. */
  listDeploys(
    filter: { status?: DeployStatus; repo?: string; sha?: string; serviceId?: string } = {},
    { limit = 100, newestFirst = false }: { limit?: number; newestFirst?: boolean } = {},
  ) {
    const conditions: [string, string | undefined][] = [
      ["status = ?", filter.status],
      ["repo = ?", filter.repo && normalizeRepo(filter.repo)],
      ["sha = ?", filter.sha],
      ["service_id = ?", filter.serviceId],
    ];
    const active = conditions.filter((c): c is [string, string] => Boolean(c[1]));
    const where = active.map(([sql]) => sql);
    const params = active.map(([, value]) => value);
    const sql = `SELECT * FROM deploys ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at ${newestFirst ? "DESC" : "ASC"} LIMIT ?`;
    return this.db
      .prepare(sql)
      .all(...params, limit)
      .map(toDeploy);
  }

  /** Moves a deploy to `to` only if the state machine allows it; returns the updated record or undefined. */
  transition(
    id: string,
    to: DeployStatus,
    now: Date,
    extra: { error?: string; deployStartedAt?: Date } = {},
  ): DeployRecord | undefined {
    const current = this.getDeploy(id);
    if (!current || !canTransition(current.status, to)) return undefined;
    const result = this.db
      .prepare(
        `UPDATE deploys SET status = ?, error = ?, deploy_started_at = COALESCE(?, deploy_started_at), updated_at = ?
         WHERE id = ? AND status = ?`,
      )
      .run(
        to,
        extra.error ?? null,
        extra.deployStartedAt?.toISOString() ?? null,
        now.toISOString(),
        id,
        current.status,
      );
    return result.changes === 1 ? this.getDeploy(id) : undefined;
  }
}
