import type { Role } from "@keel/shared";
import { describe, expect, it } from "vitest";
import { type Principal, roleOn } from "./access";
import {
  compareSpecificity,
  effectiveRole,
  forbidden,
  type GrantRule,
  globMatch,
  normalizeGrantPatterns,
} from "./roles";
import type { Member } from "./store";

const grant = (repoPattern: string, servicePattern: string, role: Role): GrantRule => ({
  repoPattern,
  servicePattern,
  role,
});

const app = { repo: "konectus-io/app" };

describe("globMatch", () => {
  it("treats * as any run of characters and the rest literally", () => {
    expect(globMatch("*", "konectus-io/app")).toBe(true);
    expect(globMatch("konectus-io/*", "konectus-io/app")).toBe(true);
    expect(globMatch("konectus-io/*", "jalo/app")).toBe(false);
    expect(globMatch("prod*", "prod-eu")).toBe(true);
    expect(globMatch("prod*", "api-prod")).toBe(false);
    expect(globMatch("*-prod", "api-prod")).toBe(true);
    expect(globMatch("a.b", "axb")).toBe(false);
    expect(globMatch("Konectus-IO/App", "konectus-io/app")).toBe(true);
  });
});

describe("effectiveRole", () => {
  it("uses the base role without a matching grant", () => {
    expect(effectiveRole("deployer", [], app)).toBe("deployer");
    expect(effectiveRole("deployer", [grant("jalo/*", "*", "viewer")], app)).toBe("deployer");
  });

  it("lets a grant lower or raise the role", () => {
    expect(effectiveRole("deployer", [grant("konectus-io/*", "prod*", "viewer")], { ...app, service: "prod" })).toBe(
      "viewer",
    );
    expect(effectiveRole("viewer", [grant("konectus-io/app", "*", "maintainer")], { ...app, service: "stg" })).toBe(
      "maintainer",
    );
  });

  it("picks the most specific grant: more literal characters, then fewer *, then the lower role", () => {
    const grants = [
      grant("*", "*", "admin"),
      grant("konectus-io/*", "*", "viewer"),
      grant("konectus-io/app", "*", "deployer"),
      grant("konectus-io/app", "prod*", "publisher"),
    ];
    expect(effectiveRole("viewer", grants, { ...app, service: "prod-eu" })).toBe("publisher");
    expect(effectiveRole("viewer", grants, { ...app, service: "stg" })).toBe("deployer");
    expect(effectiveRole("viewer", grants, { repo: "konectus-io/web", service: "stg" })).toBe("viewer");
    expect(effectiveRole("viewer", grants, { repo: "jalo/web" })).toBe("admin");

    // Same literal characters: fewer * wins.
    expect(compareSpecificity(grant("ab*", "*", "viewer"), grant("a*b*", "*", "viewer"))).toBeLessThan(0);
    // A full tie: the lower role wins.
    const tie = [grant("konectus-io/a*", "*", "maintainer"), grant("konectus-io/*", "a*", "viewer")];
    expect(effectiveRole("deployer", tie, { ...app, service: "api" })).toBe("viewer");
    const same = [grant("konectus-io/app", "*", "maintainer"), grant("konectus-io/app", "*", "publisher")];
    expect(effectiveRole("viewer", same, app)).toBe("publisher");
  });

  it("never lowers an admin", () => {
    expect(effectiveRole("admin", [grant("*", "*", "viewer")], { ...app, service: "prod" })).toBe("admin");
  });

  it("uses only grants for every service when the action has no service", () => {
    const grants = [grant("konectus-io/app", "prod*", "viewer"), grant("konectus-io/*", "*", "publisher")];
    expect(effectiveRole("deployer", grants, app)).toBe("publisher");
    expect(effectiveRole("deployer", [grant("konectus-io/app", "prod*", "viewer")], app)).toBe("deployer");
  });
});

describe("roleOn", () => {
  const member = (role: Role) => ({ id: "m", name: "Ana", role, status: "active" }) as Member;
  const principal = (role: Role, maxRole: Role | null, grants: GrantRule[] = []): Principal => ({
    member: member(role),
    grants: grants.map((g, i) => ({ ...g, id: String(i), memberId: "m", createdAt: "" })),
    maxRole,
    anonymousRole: null,
  });

  it("caps a token at its max_role, also for admins and raised grants", () => {
    expect(roleOn(principal("maintainer", "publisher"), app)).toBe("publisher");
    expect(roleOn(principal("admin", "viewer"), app)).toBe("viewer");
    expect(roleOn(principal("viewer", "deployer", [grant("*", "*", "maintainer")]), app)).toBe("deployer");
    expect(roleOn(principal("viewer", "deployer"), app)).toBe("viewer");
  });

  it("gives anonymous callers the anonymous role", () => {
    const anonymous = (anonymousRole: Role | null): Principal => ({
      member: null,
      grants: [],
      maxRole: null,
      anonymousRole,
    });
    expect(roleOn(anonymous("viewer"), app)).toBe("viewer");
    expect(roleOn(anonymous(null), app)).toBeNull();
  });
});

describe("forbidden", () => {
  it("is a 403 that says the role, the action and where", () => {
    const error = forbidden("viewer", "desplegar", { ...app, service: "api-prod" });
    expect(error.status).toBe(403);
    expect(error.message).toBe(
      "Tu rol (viewer) no permite desplegar en konectus-io/app/api-prod. Pide a un admin de keel que te dé acceso.",
    );
    expect(forbidden(null, "registrar versiones", app).message).toMatch(/^Tu rol \(none\) no permite registrar/);
  });
});

describe("normalizeGrantPatterns", () => {
  it("lowercases, defaults empty patterns to * and rejects invalid ones", () => {
    expect(normalizeGrantPatterns(" Konectus-IO/* ", "")).toEqual({
      repoPattern: "konectus-io/*",
      servicePattern: "*",
    });
    expect(() => normalizeGrantPatterns("a b", "*")).toThrow(/repo inválido/);
    expect(() => normalizeGrantPatterns("*", "prod/x")).toThrow(/servicio inválido/);
  });
});
