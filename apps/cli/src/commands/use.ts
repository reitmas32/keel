import * as p from "@clack/prompts";
import { getActiveOrg, keelHome, listOrgs, setActiveOrg } from "../config.js";
import { KeelError } from "../errors.js";

export async function use(org: string | undefined, home = keelHome()): Promise<void> {
  const orgs = await listOrgs(home);
  if (orgs.length === 0) throw new KeelError("No hay organizaciones configuradas. Ejecuta `keel login`.");

  let selected = org;
  if (!selected) {
    const current = await getActiveOrg(home).then(
      (c) => c.org,
      () => undefined,
    );
    const choice = await p.select({
      message: "Organización activa",
      options: orgs.map((o) => ({ value: o, label: o, hint: o === current ? "actual" : undefined })),
      initialValue: current,
    });
    if (p.isCancel(choice)) throw new KeelError("Cancelado.");
    selected = choice;
  }

  await setActiveOrg(selected, home);
  p.log.success(`Organización activa: ${selected}`);
}
