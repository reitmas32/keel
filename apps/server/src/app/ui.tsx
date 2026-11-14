import type { DeployStatus, Role, VersionCiStatus } from "@keel/shared";
import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { getContext } from "@/lib/context";
import type { MemberStatus } from "@/lib/store";
import { IconChevronRight, IconLogOut, KeelMark } from "./icons";
import { logout } from "./login/actions";
import { currentViewer, viewerIsAdmin } from "./session";
import { AppNav, NavLinks } from "./ui-client";

export function Brand({ sub }: { sub?: string }) {
  return (
    <Link href="/apps" className="brand">
      <span className="brand-mark">
        <KeelMark />
      </span>
      <span className="brand-text">
        <span className="brand-name">keel</span>
        {sub && <span className="brand-sub">{sub}</span>}
      </span>
    </Link>
  );
}

/**
 * Sidebar with the sections, who is signed in and "Salir"; on narrow screens it folds into a top bar (see
 * globals.css). Pages still check the session themselves: the shell only reads it.
 */
export async function AdminShell({ children }: { children: ReactNode }) {
  const viewer = await currentViewer();
  // Names for the open app's sidebar group; only ids and names leave the server.
  const apps = viewer ? (await (await getContext()).store.listApps()).map(({ id, name }) => ({ id, name })) : [];
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-header">
          <Brand sub="Deploys a Dokploy" />
        </div>
        <nav className="sidebar-group" aria-label="Secciones">
          <div className="sidebar-label">Administración</div>
          <NavLinks admin={viewer ? viewerIsAdmin(viewer) : false} />
        </nav>
        <AppNav apps={apps} />
        <form action={logout} className="sidebar-footer">
          {viewer && (
            <div className="sidebar-user">
              <span className="sidebar-user-name">{viewer.member.name}</span>
              <RoleBadge role={viewer.member.role} />
            </div>
          )}
          <button type="submit" className="nav-item">
            <IconLogOut />
            Salir
          </button>
        </form>
      </aside>
      <div className="content">{children}</div>
    </div>
  );
}

export interface Crumb {
  label: string;
  href?: string;
}

/** The content area's top bar with breadcrumbs, followed by the padded page container. */
export function Page({ crumbs, children }: { crumbs: Crumb[]; children: ReactNode }) {
  return (
    <>
      <header className="topbar">
        <nav aria-label="Ruta">
          <ol className="breadcrumbs">
            {crumbs.map((crumb, i) => (
              <Fragment key={crumb.href ?? crumb.label}>
                {i > 0 && (
                  <li aria-hidden="true">
                    <IconChevronRight />
                  </li>
                )}
                <li>
                  {crumb.href && i < crumbs.length - 1 ? (
                    <Link href={crumb.href}>{crumb.label}</Link>
                  ) : (
                    <span aria-current="page">{crumb.label}</span>
                  )}
                </li>
              </Fragment>
            ))}
          </ol>
        </nav>
      </header>
      <main className="page">{children}</main>
    </>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions}
    </div>
  );
}

export function Card({
  title,
  description,
  action,
  footer,
  className = "",
  children,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  footer?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <section className={`card ${className}`}>
      <div className="card-header">
        <div>
          <h2 className="card-title">{title}</h2>
          {description && <p className="card-description">{description}</p>}
        </div>
        {action}
      </div>
      {children && <div className="card-content">{children}</div>}
      {footer && <div className="card-footer">{footer}</div>}
    </section>
  );
}

export type Tone = "done" | "running" | "error" | "idle";

const DEPLOY_TONE: Record<DeployStatus, Tone> = {
  waiting_ci: "idle",
  ci_passed: "running",
  deploying: "running",
  deployed: "done",
  ci_failed: "error",
  deploy_failed: "error",
  expired: "error",
};

const VERSION_TONE: Record<VersionCiStatus, Tone> = {
  pending: "running",
  success: "done",
  failure: "error",
  cancelled: "idle",
  expired: "error",
};

export const deployTone = (status: DeployStatus) => DEPLOY_TONE[status];
export const versionTone = (status: VersionCiStatus) => VERSION_TONE[status];

/** A status pill with a subtle tinted background: green done, yellow running, red error, gray idle. */
export function StatusBadge({ tone, href, children }: { tone: Tone; href?: string | null; children: ReactNode }) {
  const className = `badge status status-${tone}`;
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className={className}>
      {children}
    </a>
  ) : (
    <span className={className}>{children}</span>
  );
}

/** What a list shows when it has nothing yet: an icon, a short title and, optionally, what to do about it. */
export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <span className="empty-icon">{icon}</span>}
      <p className="empty-title">{title}</p>
      {children && <p className="small">{children}</p>}
    </div>
  );
}

/** A member's role as a quiet outline pill. */
export function RoleBadge({ role }: { role: Role | null }) {
  return <span className="badge badge-outline role-badge">{role ?? "sin rol"}</span>;
}

export const MEMBER_STATUS: Record<MemberStatus, { label: string; tone: Tone }> = {
  invited: { label: "Invitado", tone: "running" },
  active: { label: "Activo", tone: "done" },
  disabled: { label: "Deshabilitado", tone: "error" },
};
