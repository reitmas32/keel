import Link from "next/link";
import { getContext } from "@/lib/context";
import { formatDate } from "@/lib/format";
import { requireRole } from "../session";
import { Card, Page, PageHeader } from "../ui";

const PAGE_SIZE = 50;

type Search = Promise<Record<string, string | string[] | undefined>>;

const param = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)?.trim() || undefined;

const none = <span className="muted">—</span>;

export default async function AuditPage({ searchParams }: { searchParams: Search }) {
  await requireRole("admin", undefined, { redirect: true });
  const search = await searchParams;
  const repo = param(search.repo);
  const actor = param(search.actor);
  const page = Math.max(1, Math.floor(Number(param(search.page) ?? 1)) || 1);

  const { store } = await getContext();
  const [rows, facets] = await Promise.all([
    store.listAudit({ repo, actor }, { limit: PAGE_SIZE + 1, offset: (page - 1) * PAGE_SIZE }),
    store.auditFacets(),
  ]);
  const entries = rows.slice(0, PAGE_SIZE);
  const hasNext = rows.length > PAGE_SIZE;
  const href = (p: number) => {
    const query = new URLSearchParams({
      ...(repo && { repo }),
      ...(actor && { actor }),
      ...(p > 1 && { page: String(p) }),
    });
    return `/audit${query.size ? `?${query}` : ""}`;
  };

  return (
    <Page crumbs={[{ label: "Auditoría" }]}>
      <PageHeader
        title="Auditoría"
        description="Cada cambio hecho desde la API o el admin: quién, qué, dónde y cuándo. Nunca guarda secretos."
      />

      <Card
        title="Registro"
        description={
          <form className="filters" method="get">
            <div className="field">
              <label className="label" htmlFor="audit-repo">
                Repo
              </label>
              <select id="audit-repo" className="input" name="repo" defaultValue={repo ?? ""}>
                <option value="">Todos</option>
                {facets.repos.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="label" htmlFor="audit-actor">
                Quién
              </label>
              <select id="audit-actor" className="input" name="actor" defaultValue={actor ?? ""}>
                <option value="">Todos</option>
                {facets.actors.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className="btn btn-outline">
              Filtrar
            </button>
            {(repo || actor) && (
              <Link className="btn btn-ghost" href="/audit">
                Quitar filtros
              </Link>
            )}
          </form>
        }
      >
        {entries.length === 0 ? (
          <p className="empty">Sin entradas{repo || actor ? " con estos filtros" : " todavía"}.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Cuándo</th>
                  <th>Quién</th>
                  <th>Acción</th>
                  <th>Repo / servicio</th>
                  <th>Detalles</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td className="muted nowrap">{formatDate(e.at)}</td>
                    <td>{e.actor}</td>
                    <td>
                      <code>{e.action}</code>
                    </td>
                    <td>{e.repo ? <code>{e.service ? `${e.repo}/${e.service}` : e.repo}</code> : none}</td>
                    <td>{e.details ? <div className="details">{JSON.stringify(e.details)}</div> : none}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <nav className="pagination" aria-label="Páginas">
          {page > 1 ? (
            <Link className="btn btn-outline btn-sm" href={href(page - 1)}>
              ← Anteriores
            </Link>
          ) : (
            <span />
          )}
          <span className="muted small">Página {page}</span>
          {hasNext ? (
            <Link className="btn btn-outline btn-sm" href={href(page + 1)}>
              Siguientes →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      </Card>
    </Page>
  );
}
