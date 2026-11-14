import type { ReactNode } from "react";

/** What each audit action means, in a few words. Unknown actions show their code. */
export const ACTION_LABEL: Record<string, string> = {
  login: "Inició sesión",
  "deploy.create": "Pidió un deploy",
  "deploy.approve": "Aprobó un deploy",
  "deploy.reject": "Rechazó un deploy",
  "deploy.force": "Forzó un deploy",
  "deploy.rollback": "Rollback automático",
  "ci.result": "Resultado del CI",
  "version.register": "Registró una versión",
  "scope.link": "Vinculó un scope",
  "scope.unlink": "Desvinculó un scope",
  "scope.update": "Configuró un scope",
  "lock.set": "Bloqueó un scope",
  "lock.clear": "Desbloqueó un scope",
  "app.create": "Creó una app",
  "app.update": "Configuró una app",
  "app.delete": "Eliminó una app",
  "ci_token.rotate": "Rotó el token de CI",
  "token.create": "Creó un token",
  "token.revoke": "Revocó un token",
  "member.invite": "Invitó a un miembro",
  "member.activate": "Activó su cuenta",
  "member.role": "Cambió un rol",
  "member.grant": "Cambió un permiso",
  "member.disable": "Deshabilitó a un miembro",
  "member.enable": "Habilitó a un miembro",
  "channel.create": "Creó un canal",
  "channel.update": "Editó un canal",
  "channel.enable": "Activó un canal",
  "channel.disable": "Pausó un canal",
  "channel.delete": "Eliminó un canal",
  "freeze.create": "Creó una ventana",
  "freeze.update": "Editó una ventana",
  "freeze.enable": "Activó una ventana",
  "freeze.disable": "Pausó una ventana",
  "freeze.delete": "Eliminó una ventana",
};

const isId = (key: string) => /Id$/.test(key) || key === "deploys";

function show(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "sí" : "no";
  if (Array.isArray(value)) return value.length ? value.map(show).join(", ") : "—";
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => `${k}: ${show(v)}`)
      .join(" · ");
  }
  return String(value);
}

/** An audit entry's details as `key value` pairs; ids are shortened and `via` is left out (shown next to the actor). */
export function AuditDetails({ details }: { details: Record<string, unknown> }) {
  const pairs = Object.entries(details).filter(([k, v]) => k !== "via" && v !== undefined);
  if (pairs.length === 0) return null;
  return (
    <dl className="kv-list">
      {pairs.map(([key, value]): ReactNode => {
        const text = show(value);
        const short = isId(key) && typeof value === "string" ? value.slice(0, 8) : text;
        return (
          <div key={key} className="kv">
            <dt>{key}</dt>
            <dd title={text.length > 80 || short !== text ? text : undefined}>
              {short.length > 80 ? `${short.slice(0, 80)}…` : short}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
