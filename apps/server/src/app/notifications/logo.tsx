import { LogoDiscord, LogoSlack, LogoWebhook } from "../icons";

export type ChannelKindName = "slack" | "slack_bot" | "discord" | "webhook";

export const KIND_LABEL: Record<ChannelKindName, string> = {
  slack: "Slack",
  slack_bot: "Slack (bot)",
  discord: "Discord",
  webhook: "Webhook",
};

/** A Slack bot and a Slack webhook are the same platform: same logo, same choice in the drawer. */
export const platformOf = (kind: ChannelKindName) => (kind === "slack_bot" ? "slack" : kind);

/** The platform's logo on its own tile. Decorative: the channel's kind is always written next to it. */
export function ChannelLogo({ kind, size = "md" }: { kind: ChannelKindName; size?: "sm" | "md" }) {
  return (
    <span className={`channel-logo channel-logo-${platformOf(kind)} channel-logo-${size}`} aria-hidden="true">
      {platformOf(kind) === "slack" ? <LogoSlack /> : kind === "discord" ? <LogoDiscord /> : <LogoWebhook />}
    </span>
  );
}
