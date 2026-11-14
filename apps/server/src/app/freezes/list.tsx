import { activeUntil, type FreezeWindow, WEEKDAYS } from "@/lib/freeze";
import { IconSnowflake } from "../icons";
import { EmptyState, StatusBadge } from "../ui";
import { toggleFreezeAction } from "./actions";
import { FreezeDrawer } from "./components";

const DAY_LETTERS = ["L", "M", "X", "J", "V", "S", "D"];

/** When a window applies, drawn: a week strip for weekly windows, the dates for the others. */
function Schedule({ w }: { w: FreezeWindow }) {
  if (w.kind === "weekly") {
    const allDay = w.startTime === w.endTime && w.startTime === "00:00";
    const crosses = !allDay && (w.endTime ?? "") <= (w.startTime ?? "");
    return (
      <div className="freeze-schedule">
        <div className="week-strip" role="img" aria-label={w.days.map((d) => WEEKDAYS[d - 1]).join(", ")}>
          {DAY_LETTERS.map((letter, i) => (
            <span key={letter} className={w.days.includes(i + 1) ? "is-on" : undefined}>
              {letter}
            </span>
          ))}
        </div>
        <span className="freeze-hours">
          {allDay ? (
            "todo el día"
          ) : (
            <>
              {w.startTime} → {w.endTime}
              {crosses && <span className="muted"> (+1 día)</span>}
            </>
          )}
        </span>
      </div>
    );
  }
  if (w.kind === "range") {
    return (
      <div className="freeze-schedule freeze-range">
        <span>
          <span className="channel-section-label">Desde</span>
          {w.startsAt?.replace("T", " ")}
        </span>
        <span>
          <span className="channel-section-label">Hasta</span>
          {w.endsAt?.replace("T", " ")}
        </span>
      </div>
    );
  }
  return (
    <div className="freeze-schedule">
      <span className="freeze-date">{w.startsAt}</span>
      <span className="freeze-hours">
        {w.startTime || w.endTime ? `${w.startTime ?? "00:00"} → ${w.endTime ?? "24:00"}` : "todo el día"}
      </span>
    </div>
  );
}

/** Freeze windows as cards with their state now: active ones first. Edit and pause only when `canEdit`. */
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
  const rows = windows
    .map((w) => ({ w, until: activeUntil(w, now) }))
    .sort((a, b) => Number(Boolean(b.until)) - Number(Boolean(a.until)));
  return (
    <div className="channel-grid">
      {rows.map(({ w, until }) => (
        <article
          key={w.id}
          className={`card channel-card freeze-card${until ? " is-active" : ""}${w.enabled ? "" : " is-paused"}`}
        >
          <header className="channel-head">
            <span className="freeze-icon" aria-hidden="true">
              <IconSnowflake />
            </span>
            <div className="channel-title">
              <h2>{w.name}</h2>
              <span className="small muted">
                {w.appId ? "Esta app" : "Organización"} · {w.timezone}
              </span>
            </div>
            {!w.enabled ? (
              <StatusBadge tone="idle">Pausada</StatusBadge>
            ) : until ? (
              <StatusBadge tone="error">Activa</StatusBadge>
            ) : (
              <StatusBadge tone="done">Programada</StatusBadge>
            )}
          </header>
          {until && (
            <p className="freeze-now">
              Bloqueando deploys hasta <strong>{until}</strong>
            </p>
          )}
          <Schedule w={w} />
          <div className="channel-scope">
            <span className="channel-section-label">Aplica a</span>
            <span>
              {w.scopePattern === "*" ? <span className="muted">todos los scopes</span> : <code>{w.scopePattern}</code>}
            </span>
          </div>
          <footer className="channel-foot">
            <span className="small muted">{w.createdBy ? `por ${w.createdBy}` : ""}</span>
            {canEdit && (
              <div className="channel-actions">
                <form action={toggleFreezeAction}>
                  <input type="hidden" name="freezeId" value={w.id} />
                  <input type="hidden" name="appId" value={w.appId ?? ""} />
                  <input type="hidden" name="enabled" value={w.enabled ? "0" : "1"} />
                  <button type="submit" className="btn btn-ghost btn-sm">
                    {w.enabled ? "Pausar" : "Activar"}
                  </button>
                </form>
                <FreezeDrawer appId={w.appId} timezone={w.timezone} window={w} />
              </div>
            )}
          </footer>
        </article>
      ))}
    </div>
  );
}
