import { LogoDiscord, LogoSlack, LogoWebhook } from "../icons";

export type ChannelKindName = "slack" | "discord" | "webhook";

export const KIND_LABEL: Record<ChannelKindName, string> = {
  slack: "Slack",
  discord: "Discord",
  webhook: "Webhook",
};

/** The platform's logo on its own tile. Decorative: the channel's kind is always written next to it. */
export function ChannelLogo({ kind, size = "md" }: { kind: ChannelKindName; size?: "sm" | "md" }) {
  return (
    <span className={`channel-logo channel-logo-${kind} channel-logo-${size}`} aria-hidden="true">
      {kind === "slack" ? <LogoSlack /> : kind === "discord" ? <LogoDiscord /> : <LogoWebhook />}
    </span>
  );
}
