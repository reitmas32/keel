// Shared by the server page and the client drawer, so it imports nothing that only runs on the server.

/** The event sets most channels want, named the way the admin offers them. */
export const EVENT_PRESETS = [
  { id: "all", label: "Todo", events: ["*"] },
  {
    id: "failures",
    label: "Solo fallos",
    events: ["deploy.failed", "deploy.ci_failed", "deploy.expired", "deploy.rollback"],
  },
  {
    id: "approvals",
    label: "Aprobaciones",
    events: ["deploy.approval_requested", "deploy.approved", "deploy.rejected", "deploy.forced"],
  },
] as const;

export type PresetId = (typeof EVENT_PRESETS)[number]["id"] | "custom";

/** The preset a channel's events match exactly, or `custom`. */
export function presetOf(events: readonly string[]): PresetId {
  const key = [...events].sort().join(",");
  return EVENT_PRESETS.find((p) => [...p.events].sort().join(",") === key)?.id ?? "custom";
}
