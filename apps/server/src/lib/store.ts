import { randomUUID } from "node:crypto";
import {
  type CiResultRequest,
  canTransition,
  type Deploy,
  type DeployStatus,
  isTerminal,
  type Version,
  type VersionCiStatus,
} from "@keel/shared";
import type { Db, Row } from "./db";

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

export interface ApiToken {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface ServiceLockRecord {
  serviceId: string;
  reason: string;
  /** API token name, `admin` from the admin UI, or null without a token. */
  lockedBy: string | null;
  createdAt: string;
}

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
  requestedBy: (r.requested_by as string | null) ?? null,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

const toApiToken = (r: Row): ApiToken => ({
  id: r.id as string,
  name: r.name as string,
  createdAt: r.created_at as string,
  lastUsedAt: (r.last_used_at as string | null) ?? null,
});

const toServiceLock = (r: Row): ServiceLockRecord => ({
  serviceId: r.service_id as string,
  reason: r.reason as string,
  lockedBy: (r.locked_by as string | null) ?? null,
  createdAt: r.created_at as string,
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

/**
 * All of keel's persistence. Every method is async so the same Store runs on SQLite or Postgres (see db.ts).
 * State changes that several replicas could race on (deploy transitions, claiming a deploy, queuing one)
 * are conditional updates or row-locked transactions, so they stay correct with more than one server on Postgres.
 */
export class Store {
  constructor(private readonly db: Db) {}

  /** Runs `fn` in one transaction, with a Store bound to it. */
  transaction<T>(fn: (tx: Store) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => fn(new Store(tx)));
  }

  /**
   * Inside a transaction, makes everyone else who locks the same row wait until this one commits. On Postgres it is a
   * row lock (`FOR NO KEY UPDATE`, which doesn't block inserts that reference the row); SQLite needs nothing, since
   * its transactions already run one at a time.
   */
  private async lockRow(table: "scopes" | "services", id: string): Promise<void> {
    if (this.db.dialect === "postgres")
      await this.db.get(`SELECT id FROM ${table} WHERE id = ? FOR NO KEY UPDATE`, [id]);
  }

  /**
   * Inside a transaction, serializes the work on one repo's deploys: queuing a deploy and applying a CI result take
   * this lock, so a deploy can't be queued as `waiting_ci` right after its CI result was applied and stay stuck.
   */
  lockScope(scopeId: string): Promise<void> {
    return this.lockRow("scopes", scopeId);
  }

  /** Insertion order among deploys created in the same millisecond: SQLite's rowid, Postgres's `seq` column. */
  private get deployInsertOrder() {
    return this.db.dialect === "postgres" ? "seq" : "rowid";
  }

  // --- scopes ---

  async createScope(input: { name: string; repo: string; ciTokenHash: string }, now: Date): Promise<Scope> {
    const scope = { id: randomUUID(), name: input.name, repo: normalizeRepo(input.repo), createdAt: now.toISOString() };
    await this.db.run("INSERT INTO scopes (id, name, repo, ci_token_hash, created_at) VALUES (?, ?, ?, ?, ?)", [
      scope.id,
      scope.name,
      scope.repo,
      input.ciTokenHash,
      scope.createdAt,
    ]);
    return scope;
  }

  async listScopes(): Promise<Scope[]> {
    return (await this.db.all("SELECT * FROM scopes ORDER BY name")).map(toScope);
  }

  async getScope(id: string): Promise<Scope | undefined> {
    const row = await this.db.get("SELECT * FROM scopes WHERE id = ?", [id]);
    return row ? toScope(row) : undefined;
  }

  async getScopeByRepo(repo: string): Promise<Scope | undefined> {
    const row = await this.db.get("SELECT * FROM scopes WHERE repo = ?", [normalizeRepo(repo)]);
    return row ? toScope(row) : undefined;
  }

  async getCiTokenHash(scopeId: string): Promise<string | undefined> {
    const row = await this.db.get("SELECT ci_token_hash FROM scopes WHERE id = ?", [scopeId]);
    return row?.ci_token_hash as string | undefined;
  }

  async setCiTokenHash(scopeId: string, hash: string): Promise<void> {
    await this.db.run("UPDATE scopes SET ci_token_hash = ? WHERE id = ?", [hash, scopeId]);
  }

  async deleteScope(id: string): Promise<void> {
    await this.db.run("DELETE FROM scopes WHERE id = ?", [id]);
  }

  // --- services ---

  async addService(input: Omit<Service, "id" | "createdAt">, now: Date): Promise<Service> {
    const service: Service = { ...input, id: randomUUID(), createdAt: now.toISOString() };
    await this.db.run(
      "INSERT INTO services (id, scope_id, alias, dokploy_url, kind, dokploy_id, tag_variable, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        service.id,
        service.scopeId,
        service.alias,
        service.dokployUrl,
        service.kind,
        service.dokployId,
        service.tagVariable,
        service.createdAt,
      ],
    );
    return service;
  }

  async listServices(scopeId: string): Promise<Service[]> {
    return (await this.db.all("SELECT * FROM services WHERE scope_id = ? ORDER BY alias", [scopeId])).map(toService);
  }

  async getService(id: string): Promise<Service | undefined> {
    const row = await this.db.get("SELECT * FROM services WHERE id = ?", [id]);
    return row ? toService(row) : undefined;
  }

  async getServiceByAlias(scopeId: string, alias: string): Promise<Service | undefined> {
    const row = await this.db.get("SELECT * FROM services WHERE scope_id = ? AND alias = ?", [scopeId, alias]);
    return row ? toService(row) : undefined;
  }

  async deleteService(id: string): Promise<void> {
    await this.db.run("DELETE FROM services WHERE id = ?", [id]);
  }

  // --- service locks ---

  async getServiceLock(serviceId: string): Promise<ServiceLockRecord | undefined> {
    const row = await this.db.get("SELECT * FROM service_locks WHERE service_id = ?", [serviceId]);
    return row ? toServiceLock(row) : undefined;
  }

  /** Locks a service. Locking it again replaces the reason and who locked it, keeping the original date. */
  async lockService(
    input: { serviceId: string; reason: string; lockedBy: string | null },
    now: Date,
  ): Promise<ServiceLockRecord> {
    await this.db.run(
      `INSERT INTO service_locks (service_id, reason, locked_by, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (service_id) DO UPDATE SET reason = excluded.reason, locked_by = excluded.locked_by`,
      [input.serviceId, input.reason, input.lockedBy, now.toISOString()],
    );
    return (await this.getServiceLock(input.serviceId)) as ServiceLockRecord;
  }

  /** Returns whether the service was locked. */
  async unlockService(serviceId: string): Promise<boolean> {
    return (await this.db.run("DELETE FROM service_locks WHERE service_id = ?", [serviceId])).changes > 0;
  }

  // --- API tokens ---

  async createApiToken(input: { name: string; tokenHash: string }, now: Date): Promise<ApiToken> {
    const token: ApiToken = { id: randomUUID(), name: input.name, createdAt: now.toISOString(), lastUsedAt: null };
    await this.db.run("INSERT INTO api_tokens (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)", [
      token.id,
      token.name,
      input.tokenHash,
      token.createdAt,
    ]);
    return token;
  }

  async listApiTokens(): Promise<ApiToken[]> {
    return (await this.db.all("SELECT * FROM api_tokens ORDER BY created_at DESC, name")).map(toApiToken);
  }

  async getApiTokenByName(name: string): Promise<ApiToken | undefined> {
    const row = await this.db.get("SELECT * FROM api_tokens WHERE name = ?", [name]);
    return row ? toApiToken(row) : undefined;
  }

  async getApiTokenByHash(hash: string): Promise<ApiToken | undefined> {
    const row = await this.db.get("SELECT * FROM api_tokens WHERE token_hash = ?", [hash]);
    return row ? toApiToken(row) : undefined;
  }

  async touchApiToken(id: string, now: Date): Promise<void> {
    await this.db.run("UPDATE api_tokens SET last_used_at = ? WHERE id = ?", [now.toISOString(), id]);
  }

  async deleteApiToken(id: string): Promise<void> {
    await this.db.run("DELETE FROM api_tokens WHERE id = ?", [id]);
  }

  // --- CI results ---

  async upsertCiResult(result: CiResult): Promise<void> {
    await this.db.run(
      `INSERT INTO ci_results (repo, sha, tag, status, received_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (repo, sha) DO UPDATE SET tag = excluded.tag, status = excluded.status, received_at = excluded.received_at`,
      [normalizeRepo(result.repo), result.sha, result.tag, result.status, result.receivedAt],
    );
  }

  async getCiResult(repo: string, sha: string): Promise<CiResult | undefined> {
    const row = await this.db.get("SELECT * FROM ci_results WHERE repo = ? AND sha = ?", [normalizeRepo(repo), sha]);
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
  async registerVersion(
    input: { repo: string; tag: string; sha: string; branch?: string; createdByName?: string; createdByEmail?: string },
    now: Date,
  ): Promise<Version> {
    const repo = normalizeRepo(input.repo);
    await this.db.run(
      `INSERT INTO versions (repo, tag, sha, branch, created_by_name, created_by_email, created_at, ci_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
       ON CONFLICT (repo, tag) DO UPDATE SET
         branch = COALESCE(versions.branch, excluded.branch),
         created_by_name = COALESCE(versions.created_by_name, excluded.created_by_name),
         created_by_email = COALESCE(versions.created_by_email, excluded.created_by_email)`,
      [
        repo,
        input.tag,
        input.sha,
        input.branch ?? null,
        input.createdByName ?? null,
        input.createdByEmail ?? null,
        now.toISOString(),
      ],
    );
    return (await this.getVersion(repo, input.tag)) as Version;
  }

  /** Stores a version's CI outcome, creating the version if `create-version` never registered it. */
  async recordVersionCi(
    input: { repo: string; tag: string; sha: string; status: VersionCiStatus; runUrl?: string },
    now: Date,
  ): Promise<Version> {
    const repo = normalizeRepo(input.repo);
    const ts = now.toISOString();
    await this.db.run(
      `INSERT INTO versions (repo, tag, sha, created_at, ci_status, ci_finished_at, run_url)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (repo, tag) DO UPDATE SET
         sha = excluded.sha,
         ci_status = excluded.ci_status,
         ci_finished_at = excluded.ci_finished_at,
         run_url = COALESCE(excluded.run_url, versions.run_url)`,
      [repo, input.tag, input.sha, ts, input.status, ts, input.runUrl ?? null],
    );
    return (await this.getVersion(repo, input.tag)) as Version;
  }

  async getVersion(repo: string, tag: string): Promise<Version | undefined> {
    const row = await this.db.get("SELECT * FROM versions WHERE repo = ? AND tag = ?", [normalizeRepo(repo), tag]);
    return row ? toVersion(row) : undefined;
  }

  /** Newest first. */
  async listVersions(
    repo: string,
    { limit = 20, status }: { limit?: number; status?: VersionCiStatus } = {},
  ): Promise<Version[]> {
    const params: (string | number)[] = [normalizeRepo(repo)];
    let where = "repo = ?";
    if (status) {
      where += " AND ci_status = ?";
      params.push(status);
    }
    const rows = await this.db.all(`SELECT * FROM versions WHERE ${where} ORDER BY created_at DESC, tag DESC LIMIT ?`, [
      ...params,
      limit,
    ]);
    return rows.map(toVersion);
  }

  /**
   * Marks as `expired` the versions still `pending` that were created before `cutoff`. Returns the ones this call
   * expired: with several replicas, a version another one expired first is not returned twice.
   */
  async expirePendingVersions(cutoff: Date, now: Date): Promise<Version[]> {
    const stale = (
      await this.db.all("SELECT * FROM versions WHERE ci_status = 'pending' AND created_at < ?", [cutoff.toISOString()])
    ).map(toVersion);
    const expired: Version[] = [];
    for (const v of stale) {
      const { changes } = await this.db.run(
        "UPDATE versions SET ci_status = 'expired', ci_finished_at = ? WHERE repo = ? AND tag = ? AND ci_status = 'pending'",
        [now.toISOString(), v.repo, v.tag],
      );
      if (changes === 1) expired.push(v);
    }
    return expired;
  }

  // --- deploys ---

  async insertDeploy(
    input: {
      repo: string;
      tag: string;
      sha: string;
      service: Service;
      status: DeployStatus;
      error?: string;
      requestedBy?: string | null;
    },
    now: Date,
  ): Promise<DeployRecord> {
    const id = randomUUID();
    const ts = now.toISOString();
    await this.db.run(
      `INSERT INTO deploys (id, repo, tag, sha, service_id, service_alias, status, error, ci_passed_at, finished_at,
         requested_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
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
        input.requestedBy ?? null,
        ts,
        ts,
      ],
    );
    return (await this.getDeploy(id)) as DeployRecord;
  }

  async getDeploy(id: string): Promise<DeployRecord | undefined> {
    const row = await this.db.get("SELECT * FROM deploys WHERE id = ?", [id]);
    return row ? toDeploy(row) : undefined;
  }

  /** Oldest first by default (queue order); pass `newestFirst` for history views. */
  async listDeploys(
    filter: { status?: DeployStatus; repo?: string; sha?: string; serviceId?: string } = {},
    { limit = 100, newestFirst = false }: { limit?: number; newestFirst?: boolean } = {},
  ): Promise<DeployRecord[]> {
    const conditions: [string, string | undefined][] = [
      ["status = ?", filter.status],
      ["repo = ?", filter.repo && normalizeRepo(filter.repo)],
      ["sha = ?", filter.sha],
      ["service_id = ?", filter.serviceId],
    ];
    const active = conditions.filter((c): c is [string, string] => Boolean(c[1]));
    const where = active.map(([sql]) => sql);
    const params = active.map(([, value]) => value);
    const direction = newestFirst ? "DESC" : "ASC";
    const sql = `SELECT * FROM deploys ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at ${direction}, ${this.deployInsertOrder} ${direction} LIMIT ?`;
    return (await this.db.all(sql, [...params, limit])).map(toDeploy);
  }

  /** Deploys of a repo whose id starts with `prefix`, like git's short commit hashes. */
  async findDeploysByPrefix(repo: string, prefix: string): Promise<DeployRecord[]> {
    // Without LIKE's wildcards (and Postgres's default escape character) the prefix matches literally in both engines.
    const rows = await this.db.all(
      `SELECT * FROM deploys WHERE repo = ? AND id LIKE ? ORDER BY created_at DESC, ${this.deployInsertOrder} DESC LIMIT 10`,
      [normalizeRepo(repo), `${prefix.replace(/[%_\\]/g, "")}%`],
    );
    return rows.map(toDeploy);
  }

  /**
   * Moves a deploy to `to` only if the state machine allows it; returns the updated record or undefined.
   * The UPDATE only matches while the deploy is still in the state it was read in, so when two callers race
   * (two replicas, or the worker and a CI result), exactly one wins and the other gets undefined.
   */
  async transition(
    id: string,
    to: DeployStatus,
    now: Date,
    extra: { error?: string; deployStartedAt?: Date } = {},
  ): Promise<DeployRecord | undefined> {
    const current = await this.getDeploy(id);
    if (!current || !canTransition(current.status, to)) return undefined;
    const result = await this.db.run(
      `UPDATE deploys SET status = ?, error = ?, deploy_started_at = COALESCE(?, deploy_started_at),
         ci_passed_at = COALESCE(?, ci_passed_at), finished_at = COALESCE(?, finished_at), updated_at = ?
       WHERE id = ? AND status = ?`,
      [
        to,
        extra.error ?? null,
        extra.deployStartedAt?.toISOString() ?? null,
        to === "ci_passed" ? now.toISOString() : null,
        isTerminal(to) ? now.toISOString() : null,
        now.toISOString(),
        id,
        current.status,
      ],
    );
    return result.changes === 1 ? this.getDeploy(id) : undefined;
  }

  /**
   * Claims a `ci_passed` deploy for the worker: moves it to `deploying` unless its service already has a deploy
   * `deploying`. Returns the claimed record, or undefined when someone else got there first. Runs in a transaction
   * with the service row locked, so replicas claiming deploys of the same service take turns and only one runs.
   */
  async claimDeploy(id: string, serviceId: string, now: Date): Promise<DeployRecord | undefined> {
    return this.transaction(async (tx) => {
      await tx.lockRow("services", serviceId);
      const [busy] = await tx.listDeploys({ serviceId, status: "deploying" }, { limit: 1 });
      if (busy) return undefined;
      return tx.transition(id, "deploying", now, { deployStartedAt: now });
    });
  }
}
