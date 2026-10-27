import { describe, expect, it } from "vitest";
import { canTransition, isTerminal } from "./deploy";

describe("deploy state machine", () => {
  it("allows the happy path", () => {
    expect(canTransition("waiting_ci", "ci_passed")).toBe(true);
    expect(canTransition("ci_passed", "deploying")).toBe(true);
    expect(canTransition("deploying", "deployed")).toBe(true);
  });

  it("rejects skipping CI", () => {
    expect(canTransition("waiting_ci", "deploying")).toBe(false);
  });

  it("treats failures and expiry as terminal", () => {
    expect(isTerminal("ci_failed")).toBe(true);
    expect(isTerminal("expired")).toBe(true);
    expect(isTerminal("waiting_ci")).toBe(false);
  });
});
