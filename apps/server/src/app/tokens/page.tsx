import { ROLES } from "@keel/shared";
import { tokenRoleChoices } from "@/lib/admin";
import { API_TOKEN_NAME_MAX } from "@/lib/api-auth";
import { getContext } from "@/lib/context";
import { formatDate } from "@/lib/format";
import { IconTrash } from "../icons";
import { requireMember, viewerIsAdmin } from "../session";
import { Card, Page, PageHeader, RoleBadge, StatusBadge } from "../ui";
import { ConfirmButton } from "../ui-client";
import { revokeApiTokenAction } from "./actions";
import { CreateApiTokenForm } from "./components";

export default async function TokensPage() {
  const viewer = await requireMember();
  const admin = viewerIsAdmin(viewer);
  const { store, env } = await getContext();
  // Admins see and revoke everyone's tokens; everyone else only their own.
  const tokens = await store.listApiTokens(admin ? {} : { memberId: viewer.member.id });
  const required = env.KEEL_API_AUTH === "required";

  return (
    <Page crumbs={[{ label: "Tokens de API" }]}>
      <PageHeader
        title="Tokens de API"
        description="Tokens personales para el CLI. Actúan con tu rol (o con su rol máximo, si es menor). keel guarda solo su hash."
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
                Esta instancia tiene <code>KEEL_API_AUTH=optional</code>: sin token, el CLI actúa con el rol{" "}
                <code>{env.KEEL_ANONYMOUS_ROLE}</code> (<code>KEEL_ANONYMOUS_ROLE</code>). Con un token, con tu rol, y
                los deploys registran quién los pidió.
              </>
            )
          }
        >
          <CreateApiTokenForm maxLength={API_TOKEN_NAME_MAX} roles={tokenRoleChoices(viewer, ROLES)} />
        </Card>

        <Card
          title={admin ? "Todos los tokens" : "Tus tokens"}
          description="Revocar un token lo invalida al instante. Si se deshabilita a su dueño, deja de funcionar."
        >
          {tokens.length === 0 ? (
            <p className="empty">Todavía no hay tokens.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Nombre</th>
                    {admin && <th>Dueño</th>}
                    <th>Rol máximo</th>
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
                      {admin && <td>{token.ownerName ?? <span className="muted">—</span>}</td>}
                      <td>{token.maxRole ? <RoleBadge role={token.maxRole} /> : <span className="muted">—</span>}</td>
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
