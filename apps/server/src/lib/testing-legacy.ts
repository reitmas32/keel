import { expect } from "vitest";
import type { Store } from "./store";

// Databases as older keel versions left them, for the migration tests. Before v0.7.0 the linked repos were `scopes`
// and their deploy targets `services`; v0.7.0 renamed them to `apps` and `scopes`.

/** keel v0.5.0's SQLite schema, as its db.ts created it: before members, tokens and locks. */
export const SQLITE_V050_SCHEMA = `
CREATE TABLE scopes (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo TEXT NOT NULL UNIQUE, ci_token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL);
CREATE TABLE services (id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
  alias TEXT NOT NULL, dokploy_url TEXT NOT NULL, kind TEXT NOT NULL, dokploy_id TEXT NOT NULL, tag_variable TEXT,
  created_at TEXT NOT NULL, UNIQUE (scope_id, alias));
CREATE TABLE ci_results (repo TEXT NOT NULL, sha TEXT NOT NULL, tag TEXT NOT NULL, status TEXT NOT NULL,
  received_at TEXT NOT NULL, PRIMARY KEY (repo, sha));
CREATE TABLE deploys (id TEXT PRIMARY KEY, repo TEXT NOT NULL, tag TEXT NOT NULL, sha TEXT NOT NULL,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE, service_alias TEXT NOT NULL,
  status TEXT NOT NULL, error TEXT, deploy_started_at TEXT, ci_passed_at TEXT, finished_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX deploys_status ON deploys (status, created_at);
CREATE INDEX deploys_repo_sha ON deploys (repo, sha);
CREATE TABLE versions (repo TEXT NOT NULL, tag TEXT NOT NULL, sha TEXT NOT NULL, branch TEXT, created_by_name TEXT,
  created_by_email TEXT, created_at TEXT NOT NULL, ci_status TEXT NOT NULL, ci_finished_at TEXT, run_url TEXT,
  PRIMARY KEY (repo, tag));
`;

/** keel v0.6.0's SQLite schema: v0.5.0's plus members, grants, invites, API tokens, locks and the audit log. */
export const SQLITE_V060_SCHEMA = `${SQLITE_V050_SCHEMA}
ALTER TABLE deploys ADD COLUMN requested_by TEXT;
CREATE INDEX versions_repo_created ON versions (repo, created_at);
CREATE INDEX versions_status ON versions (ci_status, created_at);
CREATE TABLE members (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
  password_hash TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, last_login_at TEXT);
CREATE TABLE member_grants (id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  repo_pattern TEXT NOT NULL DEFAULT '*', service_pattern TEXT NOT NULL DEFAULT '*', role TEXT NOT NULL,
  created_at TEXT NOT NULL);
CREATE INDEX member_grants_member ON member_grants (member_id);
CREATE TABLE invites (token_hash TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL, used_at TEXT);
CREATE INDEX invites_member ON invites (member_id);
CREATE TABLE api_tokens (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL, last_used_at TEXT, member_id TEXT REFERENCES members(id) ON DELETE CASCADE, max_role TEXT);
CREATE INDEX api_tokens_member ON api_tokens (member_id);
CREATE TABLE service_locks (service_id TEXT PRIMARY KEY REFERENCES services(id) ON DELETE CASCADE,
  reason TEXT NOT NULL, locked_by TEXT, created_at TEXT NOT NULL);
CREATE TABLE audit_log (id TEXT PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL,
  actor_member_id TEXT REFERENCES members(id) ON DELETE SET NULL, action TEXT NOT NULL, repo TEXT, service TEXT,
  details TEXT);
CREATE INDEX audit_log_at ON audit_log (at);
CREATE INDEX audit_log_repo ON audit_log (repo, at);
INSERT INTO members (id, name, email, role, password_hash, status, created_at)
  VALUES ('bootstrap-admin', 'admin', 'admin@localhost', 'admin', NULL, 'active', '2026-10-01T00:00:00.000Z');
`;

const T = "2026-10-26T12:00:00.000Z";
const T2 = "2026-10-26T12:05:00.000Z";
export const LEGACY_SHA = "a".repeat(40);

/** An app with two targets (one locked) and their deploys, in the old names. Valid SQL on SQLite and Postgres. */
export const LEGACY_V050_DATA = [
  `INSERT INTO scopes (id, name, repo, ci_token_hash, created_at) VALUES ('s1', 'app', 'konectus-io/app', 'hash', '${T}')`,
  `INSERT INTO services (id, scope_id, alias, dokploy_url, kind, dokploy_id, tag_variable, created_at) VALUES
    ('sv1', 's1', 'prod', 'https://d/services/compose/c1', 'compose', 'c1', 'DOCKER_TAG', '${T}'),
    ('sv2', 's1', 'stg', 'https://d/services/application/a1', 'application', 'a1', NULL, '${T}')`,
  `INSERT INTO ci_results (repo, sha, tag, status, received_at) VALUES ('konectus-io/app', '${LEGACY_SHA}', 'v1', 'success', '${T}')`,
  `INSERT INTO versions (repo, tag, sha, branch, created_at, ci_status, ci_finished_at)
    VALUES ('konectus-io/app', 'v1', '${LEGACY_SHA}', 'main', '${T}', 'success', '${T}')`,
  `INSERT INTO deploys (id, repo, tag, sha, service_id, service_alias, status, error, deploy_started_at, ci_passed_at,
      finished_at, created_at, updated_at) VALUES
    ('d1', 'konectus-io/app', 'v1', '${LEGACY_SHA}', 'sv1', 'prod', 'deployed', NULL, '${T}', '${T}', '${T2}', '${T}', '${T2}'),
    ('d2', 'konectus-io/app', 'v1', '${LEGACY_SHA}', 'sv2', 'stg', 'deploy_failed', 'boom', '${T}', '${T}', '${T2}', '${T2}', '${T2}')`,
];

/** v0.6.0's tables on top of LEGACY_V050_DATA: a member with a grant, a token, an invite, a lock and audit entries. */
export const LEGACY_V060_DATA = [
  ...LEGACY_V050_DATA,
  "UPDATE deploys SET requested_by = 'rafa' WHERE id = 'd1'",
  `INSERT INTO members (id, name, email, role, password_hash, status, created_at)
    VALUES ('m1', 'Rafa', 'rafa@example.com', 'deployer', NULL, 'active', '${T}')`,
  `INSERT INTO member_grants (id, member_id, repo_pattern, service_pattern, role, created_at)
    VALUES ('g1', 'm1', 'konectus-io/*', 'prod*', 'viewer', '${T}')`,
  `INSERT INTO invites (token_hash, member_id, expires_at) VALUES ('ih', 'm1', '${T2}')`,
  `INSERT INTO api_tokens (id, name, token_hash, created_at, member_id, max_role)
    VALUES ('t1', 'rafa', 'th', '${T}', 'm1', 'publisher')`,
  `INSERT INTO service_locks (service_id, reason, locked_by, created_at) VALUES ('sv1', 'release', 'rafa', '${T}')`,
  `INSERT INTO audit_log (id, at, actor, actor_member_id, action, repo, service, details) VALUES
    ('a1', '${T}', 'Rafa', 'm1', 'lock.set', 'konectus-io/app', 'prod', '{"reason":"release","via":"api"}'),
    ('a2', '${T2}', 'ci', NULL, 'ci.result', 'konectus-io/app', NULL, '{"tag":"v1"}')`,
];

/** What LEGACY_V050_DATA holds, read through the Store with the new names. */
export async function expectV050Data(store: Store) {
  expect(await store.listApps()).toEqual([
    { id: "s1", name: "app", repo: "konectus-io/app", createdAt: "2026-10-26T12:00:00.000Z", requireApproval: false },
  ]);
  expect(await store.listScopes("s1")).toEqual([
    expect.objectContaining({ id: "sv1", appId: "s1", alias: "prod", kind: "compose", tagVariable: "DOCKER_TAG" }),
    expect.objectContaining({ id: "sv2", appId: "s1", alias: "stg", kind: "application", tagVariable: null }),
  ]);
  expect(await store.listDeploys({}, { newestFirst: true })).toEqual([
    expect.objectContaining({ id: "d2", scopeId: "sv2", scope: "stg", status: "deploy_failed", error: "boom" }),
    expect.objectContaining({ id: "d1", scopeId: "sv1", scope: "prod", status: "deployed" }),
  ]);
  expect(await store.listDeploys({ scopeId: "sv1" })).toEqual([expect.objectContaining({ id: "d1" })]);
  expect(await store.getCiResult("konectus-io/app", LEGACY_SHA)).toMatchObject({ tag: "v1", status: "success" });
  expect(await store.getVersion("konectus-io/app", "v1")).toMatchObject({ branch: "main", ciStatus: "success" });
}

/** What LEGACY_V060_DATA adds, read through the Store with the new names. */
export async function expectV060Data(store: Store) {
  await expectV050Data(store);
  expect(await store.getDeploy("d1")).toMatchObject({ requestedBy: "rafa" });
  expect(await store.getScopeLock("sv1")).toEqual({
    scopeId: "sv1",
    reason: "release",
    lockedBy: "rafa",
    createdAt: "2026-10-26T12:00:00.000Z",
  });
  expect(await store.getScopeLock("sv2")).toBeUndefined();
  expect(await store.listGrants("m1")).toEqual([
    expect.objectContaining({ id: "g1", repoPattern: "konectus-io/*", scopePattern: "prod*", role: "viewer" }),
  ]);
  expect(await store.getInvite("ih")).toMatchObject({ memberId: "m1", usedAt: null });
  expect(await store.listApiTokens()).toEqual([
    expect.objectContaining({ id: "t1", name: "rafa", memberId: "m1", maxRole: "publisher", ownerName: "Rafa" }),
  ]);
  expect(await store.listAudit()).toEqual([
    expect.objectContaining({ id: "a2", action: "ci.result", repo: "konectus-io/app", scope: null }),
    expect.objectContaining({
      id: "a1",
      action: "lock.set",
      scope: "prod",
      details: { reason: "release", via: "api" },
    }),
  ]);
  expect((await store.listAudit({ scope: "prod" })).map((e) => e.id)).toEqual(["a1"]);
  expect(await store.listMembers()).toHaveLength(2);
}
