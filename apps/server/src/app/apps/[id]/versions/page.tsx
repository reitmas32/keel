import { getContext } from "@/lib/context";
import { IconTag } from "../../../icons";
import { Card, EmptyState, StatusBadge, VERSION_LABEL, versionTone, When } from "../../../ui";
import { AppPage, loadApp, none } from "../shared";

const LIMIT = 50;

export default async function VersionsPage({ params }: { params: Promise<{ id: string }> }) {
  const { app, appRole } = await loadApp(params);
  const { store } = await getContext();
  const versions = await store.listVersions(app.repo, { limit: LIMIT });

  return (
    <AppPage app={app} appRole={appRole} section="Versiones">
      <Card title="Versiones" description={`Las ${LIMIT} más recientes, de keel create-version o de su CI.`}>
        {versions.length === 0 ? (
          <EmptyState icon={<IconTag />} title="Sin versiones todavía">
            Aparecen al crearlas con <code>keel create-version</code> o cuando su CI avisa.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Versión</th>
                  <th>Rama</th>
                  <th>Creada por</th>
                  <th>CI</th>
                  <th>Creada</th>
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => (
                  <tr key={v.tag}>
                    <td>
                      <code>{v.tag}</code>
                    </td>
                    <td>{v.branch ? <code>{v.branch}</code> : none}</td>
                    <td>{v.createdByName ?? v.createdByEmail ?? none}</td>
                    <td>
                      <StatusBadge tone={versionTone(v.ciStatus)} href={v.runUrl}>
                        {VERSION_LABEL[v.ciStatus]}
                      </StatusBadge>
                    </td>
                    <td className="muted nowrap">
                      <When iso={v.createdAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </AppPage>
  );
}
