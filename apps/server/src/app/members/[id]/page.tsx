import { notFound } from "next/navigation";
import { getContext } from "@/lib/context";
import { formatDate } from "@/lib/format";
import { BOOTSTRAP_ADMIN } from "@/lib/postgres-schema.mjs";
import { requireRole } from "../../session";
import { Card, Page, PageHeader, RoleBadge, MEMBER_STATUS as STATUS, StatusBadge } from "../../ui";
import { AddGrantForm, ChangeRoleForm, RemoveGrantButton, ResendInviteForm, SetEnabledForm } from "../components";

export default async function MemberPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireRole("admin", undefined, { redirect: true });
  const { store } = await getContext();
  const member = await store.getMember((await params).id);
  if (!member) notFound();
  const grants = await store.listGrants(member.id);
  const bootstrap = member.id === BOOTSTRAP_ADMIN.id;
  const self = member.id === viewer.member.id;

  return (
    <Page crumbs={[{ label: "Miembros", href: "/members" }, { label: member.name }]}>
      <PageHeader
        title={member.name}
        description={
          <>
            {member.email} · desde {formatDate(member.createdAt)} · último acceso{" "}
            {member.lastLoginAt ? formatDate(member.lastLoginAt) : "nunca"}
            {self && " · eres tú"}
          </>
        }
        actions={
          <span className="inline-form">
            <RoleBadge role={member.role} />
            <StatusBadge tone={STATUS[member.status].tone}>{STATUS[member.status].label}</StatusBadge>
          </span>
        }
      />

      <div className="stack">
        <Card
          title="Rol"
          description="El rol base aplica en todos los repos y servicios, salvo donde un permiso lo cambie. Un admin es admin en todo."
        >
          <ChangeRoleForm memberId={member.id} role={member.role} />
        </Card>

        <Card
          title="Permisos por repo y servicio"
          description={
            <>
              Cambian el rol (hacia arriba o hacia abajo) donde coinciden los patrones; <code>*</code> es cualquier
              cosa. Gana el más específico (más caracteres literales, menos <code>*</code>) y, empatados, el rol más
              bajo.
            </>
          }
          footer={<AddGrantForm memberId={member.id} />}
        >
          {grants.length === 0 ? (
            <p className="empty">Sin permisos: aplica el rol base en todo.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Repo</th>
                    <th>Servicio</th>
                    <th>Rol</th>
                    <th>Creado</th>
                    <th className="actions">
                      <span className="sr-only">Acciones</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {grants.map((g) => (
                    <tr key={g.id}>
                      <td>
                        <code>{g.repoPattern}</code>
                      </td>
                      <td>
                        <code>{g.servicePattern}</code>
                      </td>
                      <td>
                        <RoleBadge role={g.role} />
                      </td>
                      <td className="muted nowrap">{formatDate(g.createdAt)}</td>
                      <td className="actions">
                        <RemoveGrantButton grantId={g.id} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card
          title="Acceso"
          description={
            bootstrap
              ? "El admin de arranque no tiene contraseña: se entra como él dejando el email vacío y usando KEEL_ADMIN_PASSWORD."
              : member.status === "invited"
                ? "Todavía no pone su contraseña. Un enlace nuevo invalida los anteriores."
                : "Un enlace nuevo le permite poner otra contraseña. Deshabilitarlo cierra su sesión y apaga sus tokens."
          }
        >
          <div className="inline-form">
            {!bootstrap && member.status !== "disabled" && (
              <ResendInviteForm
                memberId={member.id}
                label={member.status === "invited" ? "Reenviar invitación" : "Enlace para cambiar contraseña"}
              />
            )}
            <SetEnabledForm memberId={member.id} enabled={member.status === "disabled"} name={member.name} />
          </div>
        </Card>
      </div>
    </Page>
  );
}
