/** `26/10/26, 14:05 UTC`: dates as the admin and API messages show them (24-hour clock, always UTC). */
export const formatDate = (iso: string) =>
  `${new Date(iso).toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short", hourCycle: "h23", timeZone: "UTC" })} UTC`;
