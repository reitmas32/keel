import { getContext } from "@/lib/context";
import { requireRole } from "../session";
import { Card, Page, PageHeader } from "../ui";
import { CreateFreezeForm } from "./components";
import { FreezeList } from "./list";

export default async function FreezesPage() {
  await requireRole("admin", undefined, { redirect: true });
  const { store, env, now } = await getContext();
  const windows = await store.listFreezes({ appId: null });

  return (
    <Page crumbs={[{ label: "Congelamientos" }]}>
      <PageHeader
        title="Congelamientos"
        description="Mientras una ventana está activa keel rechaza los deploys nuevos (423) y retiene los que ya estaban en cola. Las de la organización aplican a todas las apps y pesan más que las de cada app: solo un admin puede forzarlas."
      />
      <Card
        title="Ventanas de la organización"
        description={
          <>
            Para desplegar durante una ventana: <code>keel deploy --force-freeze "motivo"</code>. Queda en la auditoría
            y en las notificaciones. Cada app puede tener además sus propias ventanas en su Configuración.
          </>
        }
        footer={<CreateFreezeForm appId={null} timezone={env.KEEL_TIMEZONE ?? "UTC"} />}
      >
        <FreezeList windows={windows} now={now()} canEdit />
      </Card>
    </Page>
  );
}
