/** `26/10/26, 14:05 UTC`: dates as the admin and API messages show them (24-hour clock, always UTC). */
export const formatDate = (iso: string) =>
  `${new Date(iso).toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short", hourCycle: "h23", timeZone: "UTC" })} UTC`;

/** `hace 5 min`, `hace 3 h`, `ayer`, or the date for anything older than a week. */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const seconds = Math.round((now.getTime() - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return "hace un momento";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.round(hours / 24);
  if (days === 1) return "ayer";
  if (days < 7) return `hace ${days} días`;
  return formatDate(iso);
}
