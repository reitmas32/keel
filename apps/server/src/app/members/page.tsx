import Link from "next/link";
import { getContext } from "@/lib/context";
import { formatDate } from "@/lib/format";
import { requireRole } from "../session";
import { Card, Page, PageHeader, RoleBadge, MEMBER_STATUS as STATUS, StatusBadge } from "../ui";
import { InviteMemberForm } from "./components";

export default async function MembersPage() {
  await requireRole("admin", undefined, { redirect: true });
  const { store } = await getContext();
  const members = await store.listMembers();

  return (
    <Page crumbs={[{ label: "Miembros" }]}>
      <PageHeader
        title="Miembros"
        description="Quién puede entrar a keel y qué puede hacer. Los permisos por repo o scope ajustan el rol base."
      />

      <div className="stack">
        <Card
          title="Invitar"
          description="Crea al miembro y te da un enlace de un solo uso para que ponga su contraseña."
        >
          <InviteMemberForm />
        </Card>

        <Card title="Miembros" description={members.length === 1 ? "1 miembro" : `${members.length} miembros`}>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Email</th>
                  <th>Rol</th>
                  <th>Estado</th>
                  <th>Último acceso</th>
                  <th>Permisos</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <Link className="link" href={`/members/${m.id}`}>
                        <strong>{m.name}</strong>
                      </Link>
                    </td>
                    <td className="muted">{m.email}</td>
                    <td>
                      <RoleBadge role={m.role} />
                    </td>
                    <td>
                      <StatusBadge tone={STATUS[m.status].tone}>{STATUS[m.status].label}</StatusBadge>
                    </td>
                    <td className="muted nowrap">{m.lastLoginAt ? formatDate(m.lastLoginAt) : "Nunca"}</td>
                    <td className="muted">{m.grants}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </Page>
  );
}
