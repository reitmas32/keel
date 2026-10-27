import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type CiResultRequest,
  canTransition,
  type Deploy,
  type DeployStatus,
  isTerminal,
  type Version,
  type VersionCiStatus,
} from "@keel/shared";

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
  /** Compose only: env variable keel sets to the version tag before redeploying. */
  tagVariable: string | null;
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
  ciPassedAt: string | null;
  finishedAt: string | null;
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
  tagVariable: (r.tag_variable as string | null) ?? null,
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
  ciPassedAt: (r.ci_passed_at as string | null) ?? null,
  finishedAt: (r.finished_at as string | null) ?? null,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

const toVersion = (r: Row): Version => ({
  repo: r.repo as string,
  tag: r.tag as string,
  sha: r.sha as string,
  branch: (r.branch as string | null) ?? null,
  createdByName: (r.created_by_name as string | null) ?? null,
  createdByEmail: (r.created_by_email as string | null) ?? null,
  createdAt: r.created_at as string,
  ciStatus: r.ci_status as VersionCiStatus,
  ciFinishedAt: (r.ci_finished_at as string | null) ?? null,
  runUrl: (r.run_url as string | null) ?? null,
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
        "INSERT INTO services (id, scope_id, alias, dokploy_url, kind, dokploy_id, tag_variable, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        service.id,
        service.scopeId,
        service.alias,
        service.dokployUrl,
        service.kind,
        service.dokployId,
        service.tagVariable,
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

  // --- versions ---

  /**
   * Records a version `keel create-version` just pushed, as `pending`. If keel already knows it (its CI
   * reported first), only the fields it was missing are filled in: the CI outcome is never overwritten.
   */
  registerVersion(
    input: { repo: string; tag: string; sha: string; branch?: string; createdByName?: string; createdByEmail?: string },
    now: Date,
  ): Version {
    const repo = normalizeRepo(input.repo);
    this.db
      .prepare(
        `INSERT INTO versions (repo, tag, sha, branch, created_by_name, created_by_email, created_at, ci_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
         ON CONFLICT (repo, tag) DO UPDATE SET
           branch = COALESCE(versions.branch, excluded.branch),
           created_by_name = COALESCE(versions.created_by_name, excluded.created_by_name),
           created_by_email = COALESCE(versions.created_by_email, excluded.created_by_email)`,
      )
      .run(
        repo,
        input.tag,
        input.sha,
        input.branch ?? null,
        input.createdByName ?? null,
        input.createdByEmail ?? null,
        now.toISOString(),
      );
    return this.getVersion(repo, input.tag) as Version;
  }

  /** Stores a version's CI outcome, creating the version if `create-version` never registered it. */
  recordVersionCi(
    input: { repo: string; tag: string; sha: string; status: VersionCiStatus; runUrl?: string },
    now: Date,
  ): Version {
    const repo = normalizeRepo(input.repo);
    const ts = now.toISOString();
    this.db
      .prepare(
        `INSERT INTO versions (repo, tag, sha, created_at, ci_status, ci_finished_at, run_url)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (repo, tag) DO UPDATE SET
           sha = excluded.sha,
           ci_status = excluded.ci_status,
           ci_finished_at = excluded.ci_finished_at,
           run_url = COALESCE(excluded.run_url, versions.run_url)`,
      )
      .run(repo, input.tag, input.sha, ts, input.status, ts, input.runUrl ?? null);
    return this.getVersion(repo, input.tag) as Version;
  }

  getVersion(repo: string, tag: string): Version | undefined {
    const row = this.db.prepare("SELECT * FROM versions WHERE repo = ? AND tag = ?").get(normalizeRepo(repo), tag);
    return row ? toVersion(row) : undefined;
  }

  /** Newest first. */
  listVersions(repo: string, { limit = 20, status }: { limit?: number; status?: VersionCiStatus } = {}): Version[] {
    const params: (string | number)[] = [normalizeRepo(repo)];
    let where = "repo = ?";
    if (status) {
      where += " AND ci_status = ?";
      params.push(status);
    }
    return this.db
      .prepare(`SELECT * FROM versions WHERE ${where} ORDER BY created_at DESC, tag DESC LIMIT ?`)
      .all(...params, limit)
      .map(toVersion);
  }

  /** Marks as `expired` the versions still `pending` that were created before `cutoff`. Returns them. */
  expirePendingVersions(cutoff: Date, now: Date): Version[] {
    const stale = this.db
      .prepare("SELECT * FROM versions WHERE ci_status = 'pending' AND created_at < ?")
      .all(cutoff.toISOString())
      .map(toVersion);
    const update = this.db.prepare(
      "UPDATE versions SET ci_status = 'expired', ci_finished_at = ? WHERE repo = ? AND tag = ? AND ci_status = 'pending'",
    );
    for (const v of stale) update.run(now.toISOString(), v.repo, v.tag);
    return stale;
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
        `INSERT INTO deploys (id, repo, tag, sha, service_id, service_alias, status, error, ci_passed_at, finished_at,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        // A deploy can be born already past CI when the Action reported before `keel deploy` ran.
        input.status === "ci_passed" ? ts : null,
        isTerminal(input.status) ? ts : null,
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

  /** Deploys of a repo whose id starts with `prefix`, like git's short commit hashes. */
  findDeploysByPrefix(repo: string, prefix: string): DeployRecord[] {
    return this.db
      .prepare("SELECT * FROM deploys WHERE repo = ? AND id LIKE ? ORDER BY created_at DESC LIMIT 10")
      .all(normalizeRepo(repo), `${prefix.replace(/[%_]/g, "")}%`)
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
        `UPDATE deploys SET status = ?, error = ?, deploy_started_at = COALESCE(?, deploy_started_at),
           ci_passed_at = COALESCE(?, ci_passed_at), finished_at = COALESCE(?, finished_at), updated_at = ?
         WHERE id = ? AND status = ?`,
      )
      .run(
        to,
        extra.error ?? null,
        extra.deployStartedAt?.toISOString() ?? null,
        to === "ci_passed" ? now.toISOString() : null,
        isTerminal(to) ? now.toISOString() : null,
        now.toISOString(),
        id,
        current.status,
      );
    return result.changes === 1 ? this.getDeploy(id) : undefined;
  }
}
