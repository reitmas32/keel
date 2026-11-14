import { activeUntil, describeWindow, type FreezeWindow } from "@/lib/freeze";
import { IconSnowflake, IconTrash } from "../icons";
import { EmptyState, StatusBadge } from "../ui";
import { ConfirmButton } from "../ui-client";
import { deleteFreezeAction, toggleFreezeAction } from "./actions";

/** A table of windows with their state now; actions only when `canEdit`. */
export function FreezeList({
  windows,
  now,
  canEdit,
  emptyHint,
}: {
  windows: FreezeWindow[];
  now: Date;
  canEdit: boolean;
  emptyHint?: string;
}) {
  if (windows.length === 0) {
    return (
      <EmptyState icon={<IconSnowflake />} title="Sin ventanas de congelamiento">
        {emptyHint}
      </EmptyState>
    );
  }
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Ventana</th>
            <th>Cuándo</th>
            <th>Scopes</th>
            <th>Estado</th>
            {canEdit && <th />}
          </tr>
        </thead>
        <tbody>
          {windows.map((w) => {
            const until = activeUntil(w, now);
            return (
              <tr key={w.id}>
                <td>
                  {w.name}
                  {w.createdBy && <div className="sub">por {w.createdBy}</div>}
                </td>
                <td>
                  {describeWindow(w)}
                  <div className="sub">{w.timezone}</div>
                </td>
                <td>
                  <code>{w.scopePattern}</code>
                </td>
                <td>
                  {!w.enabled ? (
                    <StatusBadge tone="idle">Pausada</StatusBadge>
                  ) : until ? (
                    <>
                      <StatusBadge tone="error">Activa</StatusBadge>
                      <div className="sub">hasta {until}</div>
                    </>
                  ) : (
                    <StatusBadge tone="done">Programada</StatusBadge>
                  )}
                </td>
                {canEdit && (
                  <td>
                    <div className="row-actions">
                      <form action={toggleFreezeAction}>
                        <input type="hidden" name="freezeId" value={w.id} />
                        <input type="hidden" name="appId" value={w.appId ?? ""} />
                        <input type="hidden" name="enabled" value={w.enabled ? "0" : "1"} />
                        <button type="submit" className="btn btn-outline btn-sm">
                          {w.enabled ? "Pausar" : "Activar"}
                        </button>
                      </form>
                      <form action={deleteFreezeAction}>
                        <input type="hidden" name="freezeId" value={w.id} />
                        <input type="hidden" name="appId" value={w.appId ?? ""} />
                        <ConfirmButton message={`¿Eliminar la ventana ${w.name}?`}>
                          <IconTrash />
                          Eliminar
                        </ConfirmButton>
                      </form>
                    </div>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
