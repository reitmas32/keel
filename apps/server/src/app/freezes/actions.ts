"use server";

import { revalidatePath } from "next/cache";
import { createFreezeAs, deleteFreezeAs, setFreezeEnabledAs } from "@/lib/admin";
import { getContext } from "@/lib/context";
import { ApiError } from "@/lib/errors";
import { requireMember } from "../session";

export interface FreezeFormState {
  error?: string;
  ok?: boolean;
}

const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

/** The pages that show windows: the organization's list, and an app's settings. */
function revalidate(appId: string | null) {
  revalidatePath("/freezes");
  if (appId) revalidatePath(`/apps/${appId}`, "layout");
}

/** Creates a window for the organization (`appId` null) or for one app. */
export async function createFreezeAction(
  appId: string | null,
  _state: FreezeFormState,
  form: FormData,
): Promise<FreezeFormState> {
  const viewer = await requireMember();
  try {
    const { store, now } = await getContext();
    await createFreezeAs(
      store,
      viewer,
      appId,
      {
        name: field(form, "name"),
        kind: field(form, "kind"),
        timezone: field(form, "timezone"),
        startsAt: field(form, field(form, "kind") === "date" ? "date" : "startsAt"),
        endsAt: field(form, "endsAt"),
        days: form.getAll("days").map(String),
        startTime: field(form, "startTime"),
        endTime: field(form, "endTime"),
        scope: field(form, "scope"),
      },
      now(),
    );
    revalidate(appId);
    return { ok: true };
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    throw error;
  }
}

export async function toggleFreezeAction(form: FormData): Promise<void> {
  const viewer = await requireMember();
  const { store, now } = await getContext();
  await setFreezeEnabledAs(store, viewer, field(form, "freezeId"), field(form, "enabled") === "1", now());
  revalidate(field(form, "appId") || null);
}

export async function deleteFreezeAction(form: FormData): Promise<void> {
  const viewer = await requireMember();
  const { store, now } = await getContext();
  await deleteFreezeAs(store, viewer, field(form, "freezeId"), now());
  revalidate(field(form, "appId") || null);
}
