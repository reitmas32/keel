import { randomUUID } from "node:crypto";
import {
  type ApprovalStatus,
  type CiResultRequest,
  canTransition,
  type Deploy,
  type DeployStatus,
  type HealthCheck,
  type HealthStatus,
  isTerminal,
  type Role,
  type Version,
  type VersionCiStatus,
} from "@keel/shared";
import type { Db, Row, SqlValue } from "./db";
import { BOOTSTRAP_ADMIN } from "./postgres-schema.mjs";

export interface App {
  id: string;
  name: string;
  repo: string;
  createdAt: string;
  /** Deploys of its scopes need a second member's approval, unless a scope says otherwise. */
  requireApproval: boolean;
}

export type ScopeKind = "application" | "compose";

export interface Scope {
  id: string;
  appId: string;
  alias: string;
  dokployUrl: string;
  kind: ScopeKind;
  dokployId: string;
  /** Compose only: env variable keel sets to the version tag before redeploying. */
  tagVariable: string | null;
  createdAt: string;
  /** What to call after Dokploy finishes a deploy; null without one. */
  healthCheck: HealthCheck | null;
  /** After a failed deploy, deploy again the version the scope ran before. */
  autoRollback: boolean;
  /** Overrides the app's `requireApproval`; null follows it. */
  requireApproval: boolean | null;
}

/** Whether deploys to `scope` need an approval: its own setting, or else its app's. */
export const approvalRequired = (app: Pick<App, "requireApproval">, scope: Pick<Scope, "requireApproval">) =>
  scope.requireApproval ?? app.requireApproval;

export interface CiResult {
  repo: string;
  sha: string;
  tag: string;
  status: CiResultRequest["status"];
  receivedAt: string;
}

/** A deploy as stored. The API adds `service` (the old name of `scope`) when it returns one. */
export interface DeployRecord extends Omit<Deploy, "service"> {
  scopeId: string;
  deployStartedAt: string | null;
  ciPassedAt: string | null;
  finishedAt: string | null;
  rollbackOf: string | null;
  healthStatus: HealthStatus | null;
  /** Health checks made so far, and when the last one started. */
  healthAttempts: number;
  healthCheckedAt: string | null;
  requestedByMemberId: string | null;
  approval: {
    status: ApprovalStatus;
    by: string | null;
    byMemberId: string | null;
    at: string | null;
    reason: string | null;
  } | null;
}

export interface ApiToken {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** The member the token acts as. Null only in a database the members migration hasn't reached. */
  memberId: string | null;
  /** The token can't act above this role, whatever its owner's role is. Null: its owner's role. */
  maxRole: Role | null;
}

/** A token with its owner's name, for the admin's list. */
export interface ApiTokenWithOwner extends ApiToken {
  ownerName: string | null;
}

export const MEMBER_STATUSES = ["invited", "active", "disabled"] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

export interface Member {
  id: string;
  name: string;
  /** Lowercased. */
  email: string;
  role: Role;
  status: MemberStatus;
  hasPassword: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface MemberGrant {
  id: string;
  memberId: string;
  repoPattern: string;
  scopePattern: string;
  role: Role;
  createdAt: string;
}

export interface Invite {
  memberId: string;
  expiresAt: string;
  usedAt: string | null;
}

export interface AuditEntry {
  id: string;
  at: string;
  /** Member name, `anónimo` for an API call without a token, or `ci` for the GitHub Action. */
  actor: string;
  actorMemberId: string | null;
  action: string;
  repo: string | null;
  scope: string | null;
  /** Parsed from the JSON column. Never holds secrets. */
  details: Record<string, unknown> | null;
}

export interface AuditFilter {
  repo?: string | undefined;
  /** A scope alias. */
  scope?: string | undefined;
  actor?: string | undefined;
}

export interface ScopeLockRecord {
  scopeId: string;
  reason: string;
  /** API token name, `admin` from the admin UI, or null without a token. */
  lockedBy: string | null;
  createdAt: string;
}

export const CHANNEL_KINDS = ["slack", "discord", "webhook"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

/** Where keel sends notifications. `url` and `secret` never leave the server unmasked. */
export interface NotificationChannel {
  id: string;
  name: string;
  kind: ChannelKind;
  url: string;
  /** Generic webhooks only: signs the body. */
  secret: string | null;
  /** Event names, or `["*"]` for all. */
  events: string[];
  repoPattern: string;
  scopePattern: string;
  enabled: boolean;
  createdAt: string;
}

const toChannel = (r: Row): NotificationChannel => ({
  id: r.id as string,
  name: r.name as string,
  kind: r.kind as ChannelKind,
  url: r.url as string,
  secret: (r.secret as string | null) ?? null,
  events: (r.events as string).split(",").filter(Boolean),
  repoPattern: r.repo_pattern as string,
  scopePattern: r.scope_pattern as string,
  enabled: Number(r.enabled) === 1,
  createdAt: r.created_at as string,
});

const toApp = (r: Row): App => ({
  id: r.id as string,
  name: r.name as string,
  repo: r.repo as string,
  createdAt: r.created_at as string,
  requireApproval: Number(r.require_approval ?? 0) === 1,
});

function parseHealthCheck(raw: unknown): HealthCheck | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    return JSON.parse(raw) as HealthCheck;
  } catch {
    return null;
  }
}

const toScope = (r: Row): Scope => ({
  id: r.id as string,
  appId: r.app_id as string,
  alias: r.alias as string,
  dokployUrl: r.dokploy_url as string,
  kind: r.kind as ScopeKind,
  dokployId: r.dokploy_id as string,
  tagVariable: (r.tag_variable as string | null) ?? null,
  createdAt: r.created_at as string,
  healthCheck: parseHealthCheck(r.health_check),
  autoRollback: Number(r.auto_rollback ?? 0) === 1,
  requireApproval: r.require_approval == null ? null : Number(r.require_approval) === 1,
});

const toDeploy = (r: Row): DeployRecord => ({
  id: r.id as string,
  repo: r.repo as string,
  tag: r.tag as string,
  sha: r.sha as string,
  scopeId: r.scope_id as string,
  scope: r.scope_alias as string,
  status: r.status as DeployStatus,
  error: (r.error as string | null) ?? null,
  deployStartedAt: (r.deploy_started_at as string | null) ?? null,
  ciPassedAt: (r.ci_passed_at as string | null) ?? null,
  finishedAt: (r.finished_at as string | null) ?? null,
  requestedBy: (r.requested_by as string | null) ?? null,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
  rollbackOf: (r.rollback_of as string | null) ?? null,
  healthStatus: (r.health_status as HealthStatus | null) ?? null,
  healthAttempts: Number(r.health_attempts ?? 0),
  healthCheckedAt: (r.health_checked_at as string | null) ?? null,
  requestedByMemberId: (r.requested_by_member_id as string | null) ?? null,
  approval: r.approval_status
    ? {
        status: r.approval_status as ApprovalStatus,
        by: (r.approval_by as string | null) ?? null,
        byMemberId: (r.approval_by_member_id as string | null) ?? null,
        at: (r.approval_at as string | null) ?? null,
        reason: (r.approval_reason as string | null) ?? null,
      }
    : null,
});

const toApiToken = (r: Row): ApiToken => ({
  id: r.id as string,
  name: r.name as string,
  createdAt: r.created_at as string,
  lastUsedAt: (r.last_used_at as string | null) ?? null,
  memberId: (r.member_id as string | null) ?? null,
  maxRole: (r.max_role as Role | null) ?? null,
});

const toMember = (r: Row): Member => ({
  id: r.id as string,
  name: r.name as string,
  email: r.email as string,
  role: r.role as Role,
  status: r.status as MemberStatus,
  hasPassword: r.password_hash != null,
  createdAt: r.created_at as string,
  lastLoginAt: (r.last_login_at as string | null) ?? null,
});

const toGrant = (r: Row): MemberGrant => ({
  id: r.id as string,
  memberId: r.member_id as string,
  repoPattern: r.repo_pattern as string,
  scopePattern: r.scope_pattern as string,
  role: r.role as Role,
  createdAt: r.created_at as string,
});

const toAudit = (r: Row): AuditEntry => {
  let details: Record<string, unknown> | null = null;
  try {
    details = r.details ? (JSON.parse(r.details as string) as Record<string, unknown>) : null;
  } catch {
    details = { raw: r.details };
  }
  return {
    id: r.id as string,
    at: r.at as string,
    actor: r.actor as string,
    actorMemberId: (r.actor_member_id as string | null) ?? null,
    action: r.action as string,
    repo: (r.repo as string | null) ?? null,
    scope: (r.scope as string | null) ?? null,
    details,
  };
};

/** Lowercased and trimmed: emails compare without case. */
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

const toScopeLock = (r: Row): ScopeLockRecord => ({
  scopeId: r.scope_id as string,
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
  private async lockRow(table: "apps" | "scopes", id: string): Promise<void> {
    if (this.db.dialect === "postgres")
      await this.db.get(`SELECT id FROM ${table} WHERE id = ? FOR NO KEY UPDATE`, [id]);
  }

  /**
   * Inside a transaction, serializes the work on one repo's deploys: queuing a deploy and applying a CI result take
   * this lock, so a deploy can't be queued as `waiting_ci` right after its CI result was applied and stay stuck.
   */
  lockAppRow(appId: string): Promise<void> {
    return this.lockRow("apps", appId);
  }

  /** Insertion order among deploys created in the same millisecond: SQLite's rowid, Postgres's `seq` column. */
  private get deployInsertOrder() {
    return this.db.dialect === "postgres" ? "seq" : "rowid";
  }

  // --- apps ---

  async createApp(input: { name: string; repo: string; ciTokenHash: string }, now: Date): Promise<App> {
    const app: App = {
      id: randomUUID(),
      name: input.name,
      repo: normalizeRepo(input.repo),
      createdAt: now.toISOString(),
      requireApproval: false,
    };
    await this.db.run("INSERT INTO apps (id, name, repo, ci_token_hash, created_at) VALUES (?, ?, ?, ?, ?)", [
      app.id,
      app.name,
      app.repo,
      input.ciTokenHash,
      app.createdAt,
    ]);
    return app;
  }

  async listApps(): Promise<App[]> {
    return (await this.db.all("SELECT * FROM apps ORDER BY name")).map(toApp);
  }

  async getApp(id: string): Promise<App | undefined> {
    const row = await this.db.get("SELECT * FROM apps WHERE id = ?", [id]);
    return row ? toApp(row) : undefined;
  }

  async getAppByRepo(repo: string): Promise<App | undefined> {
    const row = await this.db.get("SELECT * FROM apps WHERE repo = ?", [normalizeRepo(repo)]);
    return row ? toApp(row) : undefined;
  }

  async getCiTokenHash(appId: string): Promise<string | undefined> {
    const row = await this.db.get("SELECT ci_token_hash FROM apps WHERE id = ?", [appId]);
    return row?.ci_token_hash as string | undefined;
  }

  async setCiTokenHash(appId: string, hash: string): Promise<void> {
    await this.db.run("UPDATE apps SET ci_token_hash = ? WHERE id = ?", [hash, appId]);
  }

  async setAppRequireApproval(id: string, required: boolean): Promise<void> {
    await this.db.run("UPDATE apps SET require_approval = ? WHERE id = ?", [required ? 1 : 0, id]);
  }

  async deleteApp(id: string): Promise<void> {
    await this.db.run("DELETE FROM apps WHERE id = ?", [id]);
  }

  // --- scopes ---

  async addScope(
    input: Omit<Scope, "id" | "createdAt" | "healthCheck" | "autoRollback" | "requireApproval">,
    now: Date,
  ): Promise<Scope> {
    const scope: Scope = {
      ...input,
      id: randomUUID(),
      createdAt: now.toISOString(),
      healthCheck: null,
      autoRollback: false,
      requireApproval: null,
    };
    await this.db.run(
      "INSERT INTO scopes (id, app_id, alias, dokploy_url, kind, dokploy_id, tag_variable, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        scope.id,
        scope.appId,
        scope.alias,
        scope.dokployUrl,
        scope.kind,
        scope.dokployId,
        scope.tagVariable,
        scope.createdAt,
      ],
    );
    return scope;
  }

  async listScopes(appId: string): Promise<Scope[]> {
    return (await this.db.all("SELECT * FROM scopes WHERE app_id = ? ORDER BY alias", [appId])).map(toScope);
  }

  /** Every scope of every app, with its app's repo, by repo and alias. */
  async listAllScopes(): Promise<(Scope & { repo: string })[]> {
    const rows = await this.db.all(
      "SELECT scopes.*, apps.repo AS repo FROM scopes JOIN apps ON apps.id = scopes.app_id ORDER BY apps.repo, scopes.alias",
    );
    return rows.map((r) => ({ ...toScope(r), repo: r.repo as string }));
  }

  async getScope(id: string): Promise<Scope | undefined> {
    const row = await this.db.get("SELECT * FROM scopes WHERE id = ?", [id]);
    return row ? toScope(row) : undefined;
  }

  async getScopeByAlias(appId: string, alias: string): Promise<Scope | undefined> {
    const row = await this.db.get("SELECT * FROM scopes WHERE app_id = ? AND alias = ?", [appId, alias]);
    return row ? toScope(row) : undefined;
  }

  /** Changes only the settings given. */
  async updateScopeSettings(
    id: string,
    settings: { healthCheck?: HealthCheck | null; autoRollback?: boolean; requireApproval?: boolean | null },
  ): Promise<void> {
    if (settings.requireApproval !== undefined) {
      const value = settings.requireApproval === null ? null : settings.requireApproval ? 1 : 0;
      await this.db.run("UPDATE scopes SET require_approval = ? WHERE id = ?", [value, id]);
    }
    if (settings.healthCheck !== undefined) {
      await this.db.run("UPDATE scopes SET health_check = ? WHERE id = ?", [
        settings.healthCheck ? JSON.stringify(settings.healthCheck) : null,
        id,
      ]);
    }
    if (settings.autoRollback !== undefined) {
      await this.db.run("UPDATE scopes SET auto_rollback = ? WHERE id = ?", [settings.autoRollback ? 1 : 0, id]);
    }
  }

  async deleteScope(id: string): Promise<void> {
    await this.db.run("DELETE FROM scopes WHERE id = ?", [id]);
  }

  // --- scope locks ---

  async getScopeLock(scopeId: string): Promise<ScopeLockRecord | undefined> {
    const row = await this.db.get("SELECT * FROM scope_locks WHERE scope_id = ?", [scopeId]);
    return row ? toScopeLock(row) : undefined;
  }

  /** Locks a scope. Locking it again replaces the reason and who locked it, keeping the original date. */
  async lockScope(
    input: { scopeId: string; reason: string; lockedBy: string | null },
    now: Date,
  ): Promise<ScopeLockRecord> {
    await this.db.run(
      `INSERT INTO scope_locks (scope_id, reason, locked_by, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (scope_id) DO UPDATE SET reason = excluded.reason, locked_by = excluded.locked_by`,
      [input.scopeId, input.reason, input.lockedBy, now.toISOString()],
    );
    return (await this.getScopeLock(input.scopeId)) as ScopeLockRecord;
  }

  /** Returns whether the scope was locked. */
  async unlockScope(scopeId: string): Promise<boolean> {
    return (await this.db.run("DELETE FROM scope_locks WHERE scope_id = ?", [scopeId])).changes > 0;
  }

  // --- API tokens ---

  async createApiToken(
    input: { name: string; tokenHash: string; memberId: string; maxRole?: Role | null },
    now: Date,
  ): Promise<ApiToken> {
    const token: ApiToken = {
      id: randomUUID(),
      name: input.name,
      createdAt: now.toISOString(),
      lastUsedAt: null,
      memberId: input.memberId,
      maxRole: input.maxRole ?? null,
    };
    await this.db.run(
      "INSERT INTO api_tokens (id, name, token_hash, created_at, member_id, max_role) VALUES (?, ?, ?, ?, ?, ?)",
      [token.id, token.name, input.tokenHash, token.createdAt, token.memberId, token.maxRole],
    );
    return token;
  }

  /** Every token, or only one member's, newest first, with the owner's name. */
  async listApiTokens(filter: { memberId?: string } = {}): Promise<ApiTokenWithOwner[]> {
    const where = filter.memberId ? "WHERE t.member_id = ?" : "";
    const rows = await this.db.all(
      `SELECT t.*, m.name AS owner_name FROM api_tokens t LEFT JOIN members m ON m.id = t.member_id ${where}
       ORDER BY t.created_at DESC, t.name`,
      filter.memberId ? [filter.memberId] : [],
    );
    return rows.map((r) => ({ ...toApiToken(r), ownerName: (r.owner_name as string | null) ?? null }));
  }

  async getApiToken(id: string): Promise<ApiToken | undefined> {
    const row = await this.db.get("SELECT * FROM api_tokens WHERE id = ?", [id]);
    return row ? toApiToken(row) : undefined;
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

  // --- members ---

  async createMember(
    input: { name: string; email: string; role: Role; status: MemberStatus; passwordHash?: string | null },
    now: Date,
  ): Promise<Member> {
    const id = randomUUID();
    await this.db.run(
      "INSERT INTO members (id, name, email, role, password_hash, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        input.name,
        normalizeEmail(input.email),
        input.role,
        input.passwordHash ?? null,
        input.status,
        now.toISOString(),
      ],
    );
    return (await this.getMember(id)) as Member;
  }

  async getMember(id: string): Promise<Member | undefined> {
    const row = await this.db.get("SELECT * FROM members WHERE id = ?", [id]);
    return row ? toMember(row) : undefined;
  }

  async getMemberByEmail(email: string): Promise<Member | undefined> {
    const row = await this.db.get("SELECT * FROM members WHERE email = ?", [normalizeEmail(email)]);
    return row ? toMember(row) : undefined;
  }

  async getMemberPasswordHash(id: string): Promise<string | null> {
    const row = await this.db.get("SELECT password_hash FROM members WHERE id = ?", [id]);
    return (row?.password_hash as string | null | undefined) ?? null;
  }

  /** Every member by name, with how many grants each has. */
  async listMembers(): Promise<(Member & { grants: number })[]> {
    const rows = await this.db.all(
      `SELECT m.*, (SELECT count(*) FROM member_grants g WHERE g.member_id = m.id) AS grant_count
       FROM members m ORDER BY lower(m.name), m.email`,
    );
    return rows.map((r) => ({ ...toMember(r), grants: Number(r.grant_count) }));
  }

  async countActiveAdmins(): Promise<number> {
    const row = await this.db.get("SELECT count(*) AS n FROM members WHERE role = 'admin' AND status = 'active'");
    return Number(row?.n ?? 0);
  }

  async setMemberRole(id: string, role: Role): Promise<void> {
    await this.db.run("UPDATE members SET role = ? WHERE id = ?", [role, id]);
  }

  async setMemberStatus(id: string, status: MemberStatus): Promise<void> {
    await this.db.run("UPDATE members SET status = ? WHERE id = ?", [status, id]);
  }

  async setMemberPassword(id: string, passwordHash: string): Promise<void> {
    await this.db.run("UPDATE members SET password_hash = ? WHERE id = ?", [passwordHash, id]);
  }

  async touchMemberLogin(id: string, now: Date): Promise<void> {
    await this.db.run("UPDATE members SET last_login_at = ? WHERE id = ?", [now.toISOString(), id]);
  }

  /** The member `KEEL_ADMIN_PASSWORD` signs in as, recreated if it went missing. */
  async ensureBootstrapAdmin(now: Date): Promise<Member> {
    await this.db.run(
      `INSERT INTO members (id, name, email, role, password_hash, status, created_at)
       VALUES (?, ?, ?, 'admin', NULL, 'active', ?) ON CONFLICT DO NOTHING`,
      [BOOTSTRAP_ADMIN.id, BOOTSTRAP_ADMIN.name, BOOTSTRAP_ADMIN.email, now.toISOString()],
    );
    return (await this.getMember(BOOTSTRAP_ADMIN.id)) as Member;
  }

  // --- member grants ---

  async addGrant(
    input: { memberId: string; repoPattern: string; scopePattern: string; role: Role },
    now: Date,
  ): Promise<MemberGrant> {
    const grant: MemberGrant = { ...input, id: randomUUID(), createdAt: now.toISOString() };
    await this.db.run(
      "INSERT INTO member_grants (id, member_id, repo_pattern, scope_pattern, role, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [grant.id, grant.memberId, grant.repoPattern, grant.scopePattern, grant.role, grant.createdAt],
    );
    return grant;
  }

  async listGrants(memberId: string): Promise<MemberGrant[]> {
    const rows = await this.db.all(
      "SELECT * FROM member_grants WHERE member_id = ? ORDER BY repo_pattern, scope_pattern, created_at",
      [memberId],
    );
    return rows.map(toGrant);
  }

  async getGrant(id: string): Promise<MemberGrant | undefined> {
    const row = await this.db.get("SELECT * FROM member_grants WHERE id = ?", [id]);
    return row ? toGrant(row) : undefined;
  }

  async deleteGrant(id: string): Promise<boolean> {
    return (await this.db.run("DELETE FROM member_grants WHERE id = ?", [id])).changes > 0;
  }

  // --- invites ---

  async createInvite(input: { tokenHash: string; memberId: string; expiresAt: Date }): Promise<void> {
    await this.db.run("INSERT INTO invites (token_hash, member_id, expires_at) VALUES (?, ?, ?)", [
      input.tokenHash,
      input.memberId,
      input.expiresAt.toISOString(),
    ]);
  }

  async getInvite(tokenHash: string): Promise<Invite | undefined> {
    const row = await this.db.get("SELECT * FROM invites WHERE token_hash = ?", [tokenHash]);
    if (!row) return undefined;
    return {
      memberId: row.member_id as string,
      expiresAt: row.expires_at as string,
      usedAt: (row.used_at as string | null) ?? null,
    };
  }

  /** Marks an invite used. Returns false if it was already used, so two tabs can't both redeem it. */
  async useInvite(tokenHash: string, now: Date): Promise<boolean> {
    const { changes } = await this.db.run("UPDATE invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL", [
      now.toISOString(),
      tokenHash,
    ]);
    return changes === 1;
  }

  /** Drops a member's unused invites, so only the newest link works. */
  async deletePendingInvites(memberId: string): Promise<void> {
    await this.db.run("DELETE FROM invites WHERE member_id = ? AND used_at IS NULL", [memberId]);
  }

  // --- audit log ---

  async recordAudit(
    entry: {
      actor: string;
      actorMemberId?: string | null;
      action: string;
      repo?: string | null;
      scope?: string | null;
      details?: Record<string, unknown> | null;
    },
    now: Date,
  ): Promise<void> {
    await this.db.run(
      "INSERT INTO audit_log (id, at, actor, actor_member_id, action, repo, scope, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        randomUUID(),
        now.toISOString(),
        entry.actor,
        entry.actorMemberId ?? null,
        entry.action,
        entry.repo ? normalizeRepo(entry.repo) : null,
        entry.scope ?? null,
        entry.details ? JSON.stringify(entry.details) : null,
      ],
    );
  }

  /** Newest first. */
  async listAudit(
    filter: AuditFilter = {},
    { limit = 50, offset = 0 }: { limit?: number; offset?: number } = {},
  ): Promise<AuditEntry[]> {
    const conditions: string[] = [];
    const params: SqlValue[] = [];
    if (filter.repo) {
      conditions.push("repo = ?");
      params.push(normalizeRepo(filter.repo));
    }
    if (filter.scope) {
      conditions.push("scope = ?");
      params.push(filter.scope);
    }
    if (filter.actor) {
      conditions.push("actor = ?");
      params.push(filter.actor);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const order = this.db.dialect === "postgres" ? "seq" : "rowid";
    const rows = await this.db.all(
      `SELECT * FROM audit_log ${where} ORDER BY at DESC, ${order} DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return rows.map(toAudit);
  }

  /** The repos, scopes and actors that appear in the audit log, for its filters. */
  async auditFacets(): Promise<{ repos: string[]; scopes: string[]; actors: string[] }> {
    const repos = await this.db.all("SELECT DISTINCT repo FROM audit_log WHERE repo IS NOT NULL ORDER BY repo");
    const scopes = await this.db.all("SELECT DISTINCT scope FROM audit_log WHERE scope IS NOT NULL ORDER BY scope");
    const actors = await this.db.all("SELECT DISTINCT actor FROM audit_log ORDER BY actor");
    return {
      repos: repos.map((r) => r.repo as string),
      scopes: scopes.map((r) => r.scope as string),
      actors: actors.map((r) => r.actor as string),
    };
  }

  // --- notification channels ---

  async createChannel(
    input: Omit<NotificationChannel, "id" | "createdAt" | "enabled">,
    now: Date,
  ): Promise<NotificationChannel> {
    const id = randomUUID();
    await this.db.run(
      `INSERT INTO notification_channels (id, name, kind, url, secret, events, repo_pattern, scope_pattern, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        id,
        input.name,
        input.kind,
        input.url,
        input.secret,
        input.events.join(","),
        input.repoPattern,
        input.scopePattern,
        now.toISOString(),
      ],
    );
    return (await this.getChannel(id)) as NotificationChannel;
  }

  async listChannels(): Promise<NotificationChannel[]> {
    return (await this.db.all("SELECT * FROM notification_channels ORDER BY created_at, name")).map(toChannel);
  }

  async getChannel(id: string): Promise<NotificationChannel | undefined> {
    const row = await this.db.get("SELECT * FROM notification_channels WHERE id = ?", [id]);
    return row ? toChannel(row) : undefined;
  }

  async setChannelEnabled(id: string, enabled: boolean): Promise<void> {
    await this.db.run("UPDATE notification_channels SET enabled = ? WHERE id = ?", [enabled ? 1 : 0, id]);
  }

  async deleteChannel(id: string): Promise<void> {
    await this.db.run("DELETE FROM notification_channels WHERE id = ?", [id]);
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
      scope: Scope;
      status: DeployStatus;
      error?: string;
      requestedBy?: string | null;
      requestedByMemberId?: string | null;
      rollbackOf?: string | null;
      /** The deploy waits for a second member's approval before it starts. */
      needsApproval?: boolean;
    },
    now: Date,
  ): Promise<DeployRecord> {
    const id = randomUUID();
    const ts = now.toISOString();
    await this.db.run(
      `INSERT INTO deploys (id, repo, tag, sha, scope_id, scope_alias, status, error, ci_passed_at, finished_at,
         requested_by, requested_by_member_id, rollback_of, approval_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        normalizeRepo(input.repo),
        input.tag,
        input.sha,
        input.scope.id,
        input.scope.alias,
        input.status,
        input.error ?? null,
        // A deploy can be born already past CI when the Action reported before `keel deploy` ran.
        input.status === "ci_passed" ? ts : null,
        isTerminal(input.status) ? ts : null,
        input.requestedBy ?? null,
        input.requestedByMemberId ?? null,
        input.rollbackOf ?? null,
        input.needsApproval && !isTerminal(input.status) ? "pending" : null,
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
    filter: { status?: DeployStatus; repo?: string; sha?: string; scopeId?: string } = {},
    { limit = 100, newestFirst = false }: { limit?: number; newestFirst?: boolean } = {},
  ): Promise<DeployRecord[]> {
    const conditions: [string, string | undefined][] = [
      ["status = ?", filter.status],
      ["repo = ?", filter.repo && normalizeRepo(filter.repo)],
      ["sha = ?", filter.sha],
      ["scope_id = ?", filter.scopeId],
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
    extra: { error?: string; deployStartedAt?: Date; healthStatus?: HealthStatus } = {},
  ): Promise<DeployRecord | undefined> {
    const current = await this.getDeploy(id);
    if (!current || !canTransition(current.status, to)) return undefined;
    const result = await this.db.run(
      `UPDATE deploys SET status = ?, error = ?, deploy_started_at = COALESCE(?, deploy_started_at),
         health_status = COALESCE(?, health_status),
         ci_passed_at = COALESCE(?, ci_passed_at), finished_at = COALESCE(?, finished_at), updated_at = ?
       WHERE id = ? AND status = ?`,
      [
        to,
        extra.error ?? null,
        extra.deployStartedAt?.toISOString() ?? null,
        extra.healthStatus ?? null,
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
   * Records the decision on a pending approval. Returns false when it was no longer pending (someone else decided
   * first, or the deploy ended), so a deploy is approved or rejected exactly once.
   */
  async decideApproval(
    id: string,
    decision: { status: "approved" | "rejected"; by: string; byMemberId: string | null; reason: string | null },
    now: Date,
  ): Promise<boolean> {
    const { changes } = await this.db.run(
      `UPDATE deploys SET approval_status = ?, approval_by = ?, approval_by_member_id = ?, approval_at = ?,
         approval_reason = ?, updated_at = ?
       WHERE id = ? AND approval_status = 'pending' AND status IN ('waiting_ci', 'ci_passed')`,
      [decision.status, decision.by, decision.byMemberId, now.toISOString(), decision.reason, now.toISOString(), id],
    );
    return changes === 1;
  }

  /**
   * Takes the next health check of a `deploying` deploy: counts the attempt and stamps when it started. Returns false
   * when another replica took it first (the count no longer matches), so each attempt runs once.
   */
  async claimHealthAttempt(id: string, attemptsSoFar: number, now: Date): Promise<boolean> {
    const { changes } = await this.db.run(
      `UPDATE deploys SET health_status = 'checking', health_attempts = ?, health_checked_at = ?, updated_at = ?
       WHERE id = ? AND status = 'deploying' AND health_attempts = ?`,
      [attemptsSoFar + 1, now.toISOString(), now.toISOString(), id, attemptsSoFar],
    );
    return changes === 1;
  }

  /**
   * Claims a `ci_passed` deploy for the worker: moves it to `deploying` unless its scope already has a deploy
   * `deploying`. Returns the claimed record, or undefined when someone else got there first. Runs in a transaction
   * with the scope row locked, so replicas claiming deploys of the same scope take turns and only one runs.
   */
  async claimDeploy(id: string, scopeId: string, now: Date): Promise<DeployRecord | undefined> {
    return this.transaction(async (tx) => {
      await tx.lockRow("scopes", scopeId);
      const [busy] = await tx.listDeploys({ scopeId, status: "deploying" }, { limit: 1 });
      if (busy) return undefined;
      return tx.transition(id, "deploying", now, { deployStartedAt: now });
    });
  }
}
