import { describe, expect, it } from "vitest";
import { whoamiResponseSchema } from "./api";
import { isRole, minRole, ROLES, roleAtLeast } from "./roles";

describe("roles", () => {
  it("orders the roles", () => {
    expect(ROLES).toEqual(["viewer", "publisher", "deployer", "maintainer", "admin"]);
    expect(roleAtLeast("maintainer", "deployer")).toBe(true);
    expect(roleAtLeast("publisher", "deployer")).toBe(false);
    expect(roleAtLeast(null, "viewer")).toBe(false);
    expect(isRole("owner")).toBe(false);
  });

  it("takes the lower role, ignoring a missing side", () => {
    expect(minRole("admin", "viewer")).toBe("viewer");
    expect(minRole("publisher", null)).toBe("publisher");
    expect(minRole(null, null)).toBeNull();
  });

  it("parses whoami from old and new servers", () => {
    expect(whoamiResponseSchema.parse({ name: "rafa", auth: "optional" })).toEqual({ name: "rafa", auth: "optional" });
    const full = {
      name: "Rafa",
      email: "rafa@example.com",
      role: "deployer",
      grants: [{ repo: "konectus-io/*", scope: "prod*", service: "prod*", role: "viewer" }],
      tokenMaxRole: null,
      auth: "required",
      anonymousRole: "none",
    };
    expect(whoamiResponseSchema.parse(full)).toEqual(full);
  });
});
