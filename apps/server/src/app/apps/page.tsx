import Link from "next/link";
import { getContext } from "@/lib/context";
import { IconApps, IconLock, IconRepo, IconServer } from "../icons";
import { requireMember, viewerIsAdmin } from "../session";
import { DeployBadge, EmptyState, Page, PageHeader, StatusBadge } from "../ui";
import { CreateAppForm } from "./components";

export default async function AppsPage() {
  const viewer = await requireMember();
  const admin = viewerIsAdmin(viewer);
  const { store } = await getContext();
  const apps = await Promise.all(
    (await store.listApps()).map(async (app) => {
      const scopes = await store.listScopes(app.id);
      const [last] = await store.listDeploys({ repo: app.repo }, { limit: 1, newestFirst: true });
      const locks = await Promise.all(scopes.map((s) => store.getScopeLock(s.id)));
      return {
        ...app,
        scopes: scopes.length,
        locked: locks.filter(Boolean).length,
        last,
      };
    }),
  );

  return (
    <Page crumbs={[{ label: "Apps" }]}>
      <PageHeader
        title="Apps"
        description="Cada app vincula un repo de GitHub con sus scopes: los servicios de Dokploy a los que puede desplegar, como prod o stg."
      />

      <div className="card-grid">
        {apps.map((app) => (
          <Link key={app.id} href={`/apps/${app.id}`} className="card app-card">
            <div className="app-card-head">
              <div className="stack" style={{ gap: "0.25rem", minWidth: 0 }}>
                <h2 className="card-title">{app.name}</h2>
                <span className="muted small" style={{ overflowWrap: "anywhere" }}>
                  {app.repo}
                </span>
              </div>
              <span className="tile-icon">
                <IconRepo />
              </span>
            </div>
            <div className="app-card-meta">
              <span className="meta-item">
                <IconServer />
                {app.scopes === 1 ? "1 scope" : `${app.scopes} scopes`}
              </span>
              {app.locked > 0 && (
                <span className="meta-item">
                  <IconLock />
                  {app.locked === 1 ? "1 bloqueado" : `${app.locked} bloqueados`}
                </span>
              )}
              {app.last ? (
                <DeployBadge status={app.last.status} prefix={app.last.tag} />
              ) : (
                <StatusBadge tone="idle">sin deploys</StatusBadge>
              )}
            </div>
          </Link>
        ))}

        {admin && (
          <section className="card new-card">
            <div className="card-header">
              <div>
                <h2 className="card-title">Nueva app</h2>
                <p className="card-description">Pega la URL del repo. Te damos el token para su GitHub Action.</p>
              </div>
            </div>
            <div className="card-content">
              <CreateAppForm />
            </div>
          </section>
        )}
      </div>
      {apps.length === 0 && !admin && (
        <EmptyState icon={<IconApps />} title="Todavía no hay apps">
          Un admin de keel puede crearlas.
        </EmptyState>
      )}
    </Page>
  );
}
