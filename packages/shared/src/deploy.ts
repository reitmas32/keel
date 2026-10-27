export const DEPLOY_STATUSES = [
  "waiting_ci",
  "ci_passed",
  "deploying",
  "deployed",
  "ci_failed",
  "deploy_failed",
  "expired",
] as const;

export type DeployStatus = (typeof DEPLOY_STATUSES)[number];

export const TERMINAL_STATUSES: readonly DeployStatus[] = ["deployed", "ci_failed", "deploy_failed", "expired"];

const TRANSITIONS: Record<DeployStatus, readonly DeployStatus[]> = {
  waiting_ci: ["ci_passed", "ci_failed", "expired"],
  ci_passed: ["deploying"],
  deploying: ["deployed", "deploy_failed"],
  deployed: [],
  ci_failed: [],
  deploy_failed: [],
  expired: [],
};

export function canTransition(from: DeployStatus, to: DeployStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: DeployStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
