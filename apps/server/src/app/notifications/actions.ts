"use server";

import { revalidatePath } from "next/cache";
import { createChannelAs, deleteChannelAs, requireAdmin, setChannelEnabledAs } from "@/lib/admin";
import { getContext } from "@/lib/context";
import { ApiError } from "@/lib/errors";
import { WebhookNotifier } from "@/lib/notify";
import { requireMember } from "../session";

export interface ChannelFormState {
  error?: string;
  ok?: boolean;
  /** Result of "Probar": what the webhook answered. */
  message?: string;
}

const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

export async function createChannelAction(_state: ChannelFormState, form: FormData): Promise<ChannelFormState> {
  const viewer = await requireMember();
  try {
    const { store, now } = await getContext();
    await createChannelAs(
      store,
      viewer,
      {
        name: field(form, "name"),
        kind: field(form, "kind"),
        url: field(form, "url"),
        secret: field(form, "secret"),
        events: form.getAll("events").map(String),
        repo: field(form, "repo"),
        scope: field(form, "scope"),
      },
      now(),
    );
    revalidatePath("/notifications");
    return { ok: true };
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    throw error;
  }
}

export async function toggleChannelAction(form: FormData): Promise<void> {
  const viewer = await requireMember();
  const { store, now } = await getContext();
  await setChannelEnabledAs(store, viewer, field(form, "channelId"), field(form, "enabled") === "1", now());
  revalidatePath("/notifications");
}

export async function deleteChannelAction(form: FormData): Promise<void> {
  const viewer = await requireMember();
  const { store, now } = await getContext();
  await deleteChannelAs(store, viewer, field(form, "channelId"), now());
  revalidatePath("/notifications");
}

/** Sends a sample notification to one channel and reports what happened, without touching any deploy. */
export async function testChannelAction(channelId: string, _state: ChannelFormState): Promise<ChannelFormState> {
  const viewer = await requireMember();
  try {
    requireAdmin(viewer, "configurar notificaciones");
    const { store, env, now } = await getContext();
    const channel = await store.getChannel(channelId);
    if (!channel) throw new ApiError(404, "Canal no encontrado.");
    const failure = await new WebhookNotifier(store, env).send(
      channel,
      {
        event: "deploy.deployed",
        deploy: {
          id: "00000000-0000-0000-0000-000000000000",
          repo: "keel/prueba",
          tag: "v0.0.0",
          sha: "0000000",
          scope: "prueba",
          status: "deployed",
          error: null,
          requestedBy: viewer.member.name,
        },
        detail: "Mensaje de prueba de keel: el canal funciona.",
      },
      now().toISOString(),
    );
    return failure ? { error: `El webhook ${failure}.` } : { message: "Enviado." };
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    throw error;
  }
}
