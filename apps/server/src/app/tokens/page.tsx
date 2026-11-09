import { API_TOKEN_NAME_MAX } from "@/lib/api-auth";
import { getContext } from "@/lib/context";
import { formatDate } from "@/lib/format";
import { IconTrash } from "../icons";
import { requireAdmin } from "../session";
import { Card, Page, PageHeader, StatusBadge } from "../ui";
import { ConfirmButton } from "../ui-client";
import { revokeApiTokenAction } from "./actions";
import { CreateApiTokenForm } from "./components";

export default async function TokensPage() {
  await requireAdmin();
  const { store, env } = getContext();
  const tokens = store.listApiTokens();
  const required = env.KEEL_API_AUTH === "required";

  return (
    <Page crumbs={[{ label: "Tokens de API" }]}>
      <PageHeader
        title="Tokens de API"
        description="Tokens personales para el CLI. keel guarda solo su hash y anota su nombre en cada deploy que piden."
        actions={
          <StatusBadge tone={required ? "done" : "idle"}>
            {required ? "Token obligatorio" : "Token opcional"}
          </StatusBadge>
        }
      />

      <div className="stack">
        <Card
          title="Nuevo token"
          description={
            required ? (
              <>
                Esta instancia tiene <code>KEEL_API_AUTH=required</code>: el CLI necesita un token para todo.
              </>
            ) : (
              <>
                Esta instancia tiene <code>KEEL_API_AUTH=optional</code>: el CLI funciona sin token, pero con uno los
                deploys registran quién los pidió.
              </>
            )
          }
        >
          <CreateApiTokenForm maxLength={API_TOKEN_NAME_MAX} />
        </Card>

        <Card title="Tokens" description="Revocar un token lo invalida al instante.">
          {tokens.length === 0 ? (
            <p className="empty">Todavía no hay tokens.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Nombre</th>
                    <th>Creado</th>
                    <th>Último uso</th>
                    <th className="actions">
                      <span className="sr-only">Acciones</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {tokens.map((token) => (
                    <tr key={token.id}>
                      <td>
                        <strong>{token.name}</strong>
                      </td>
                      <td className="muted nowrap">{formatDate(token.createdAt)}</td>
                      <td className="muted nowrap">{token.lastUsedAt ? formatDate(token.lastUsedAt) : "Nunca"}</td>
                      <td className="actions">
                        <form action={revokeApiTokenAction}>
                          <input type="hidden" name="tokenId" value={token.id} />
                          <ConfirmButton
                            message={`¿Revocar el token ${token.name}? El CLI que lo use dejará de poder entrar.`}
                          >
                            <IconTrash />
                            Revocar
                          </ConfirmButton>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </Page>
  );
}
