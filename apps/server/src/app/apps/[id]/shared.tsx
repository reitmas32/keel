import "server-only";
import { type Role, roleAtLeast } from "@keel/shared";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { roleOn } from "@/lib/access";
import { getContext } from "@/lib/context";
import type { App } from "@/lib/store";
import { IconShield } from "../../icons";
import { requireMember, type Viewer } from "../../session";
import { Page, PageHeader, RoleBadge } from "../../ui";

export interface AppContext {
  viewer: Viewer;
  app: App;
  /** The member's effective role on the app (repo grants included). */
  appRole: Role | null;
  canMaintain: boolean;
}

/** The signed-in member and the app of `/apps/<id>/…`, or the 404 page. */
export async function loadApp(params: Promise<{ id: string }>): Promise<AppContext> {
  const viewer = await requireMember();
  const { store } = await getContext();
  const app = await store.getApp((await params).id);
  if (!app) notFound();
  const appRole = roleOn(viewer, { repo: app.repo });
  return { viewer, app, appRole, canMaintain: roleAtLeast(appRole, "maintainer") };
}

/** The frame every app section shares: breadcrumbs, the app's name, its repo and the member's role here. */
export function AppPage({
  app,
  appRole,
  section,
  children,
}: {
  app: App;
  appRole: Role | null;
  section: string;
  children: ReactNode;
}) {
  return (
    <Page crumbs={[{ label: "Apps", href: "/apps" }, { label: app.name, href: `/apps/${app.id}` }, { label: section }]}>
      <PageHeader
        title={section}
        description={
          <>
            {app.name} ·{" "}
            <a className="link" href={`https://github.com/${app.repo}`} target="_blank" rel="noreferrer">
              github.com/{app.repo}
            </a>
          </>
        }
        actions={
          <span className="role-hint" title="Tu rol efectivo en esta app, con tus permisos por repo">
            <IconShield />
            Tu rol aquí <RoleBadge role={appRole} />
          </span>
        }
      />
      <div className="stack">{children}</div>
    </Page>
  );
}

export const none = <span className="muted">—</span>;

/**
 * Where a version's pipeline ran. The CI reports its run URL when it finishes; until then, the repo's Actions
 * filtered by the tag (a tag push runs with the tag as its branch).
 */
export const pipelineUrl = (repo: string, tag: string, runUrl: string | null) =>
  runUrl ?? `https://github.com/${repo}/actions?query=${encodeURIComponent(`branch:${tag}`)}`;

/**
 * The Deployments tab of a scope's service in Dokploy. keel does not keep Dokploy's deployment id, and Dokploy opens
 * each deployment's logs in a dialog without a URL of its own, so the tab is the closest link.
 */
export function dokployDeploymentsUrl(dokployUrl: string): string {
  try {
    const url = new URL(dokployUrl);
    url.searchParams.set("tab", "deployments");
    return url.toString();
  } catch {
    return dokployUrl;
  }
}
