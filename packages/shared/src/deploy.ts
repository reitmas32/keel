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

// A deploy still waiting (on its CI or on an approval) can also end as `deploy_failed` when its approval is rejected,
// and as `expired` when nobody approves it in time.
const TRANSITIONS: Record<DeployStatus, readonly DeployStatus[]> = {
  waiting_ci: ["ci_passed", "ci_failed", "expired", "deploy_failed"],
  ci_passed: ["deploying", "deploy_failed", "expired"],
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
