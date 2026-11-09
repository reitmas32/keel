"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  createAppAs,
  deleteAppAs,
  linkScopeAs,
  lockScopeAs,
  rotateCiTokenAs,
  unlinkScopeAs,
  unlockScopeAs,
} from "@/lib/admin";
import { getContext } from "@/lib/context";
import { ApiError } from "@/lib/errors";
import { requireMember, type Viewer } from "../session";

export interface FormState {
  error?: string;
  /** Plaintext CI token, returned once right after it is generated. */
  token?: string;
  appId?: string;
  repo?: string;
  /** Set when the action succeeded and has nothing else to show (e.g. to close a dialog). */
  ok?: boolean;
}

const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

/**
 * Runs a mutation as the member signed in and turns expected errors (including a 403 for a role that can't) into
 * form state instead of an error page. The role checks live in lib/admin.ts.
 */
async function attempt(fn: (viewer: Viewer) => FormState | Promise<FormState>): Promise<FormState> {
  const viewer = await requireMember();
  try {
    return await fn(viewer);
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    throw error;
  }
}

export async function createAppAction(_state: FormState, form: FormData): Promise<FormState> {
  return attempt(async (viewer) => {
    const { store, now } = await getContext();
    const { app, ciToken } = await createAppAs(
      store,
      viewer,
      { name: field(form, "name"), repoUrl: field(form, "repoUrl") },
      now(),
    );
    revalidatePath("/apps");
    return { token: ciToken, appId: app.id, repo: app.repo };
  });
}

export async function addScopeAction(appId: string, _state: FormState, form: FormData): Promise<FormState> {
  return attempt(async (viewer) => {
    const { store, now } = await getContext();
    await linkScopeAs(
      store,
      viewer,
      appId,
      { alias: field(form, "alias"), dokployUrl: field(form, "dokployUrl"), tagVariable: field(form, "tagVariable") },
      now(),
    );
    revalidatePath(`/apps/${appId}`, "layout");
    return {};
  });
}

export async function rotateTokenAction(appId: string, _state: FormState): Promise<FormState> {
  return attempt(async (viewer) => {
    const { store, now } = await getContext();
    return { token: await rotateCiTokenAs(store, viewer, appId, now()) };
  });
}

export async function lockScopeAction(
  appId: string,
  scopeId: string,
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  return attempt(async (viewer) => {
    const { store, now } = await getContext();
    await lockScopeAs(store, viewer, appId, scopeId, field(form, "reason"), now());
    revalidatePath(`/apps/${appId}`, "layout");
    return { ok: true };
  });
}

// The form actions below have no form state to show an error in: their buttons only render for roles that can use
// them, so a 403 here means a crafted request and the error page is fine.

export async function unlockScopeAction(form: FormData): Promise<void> {
  const viewer = await requireMember();
  const appId = field(form, "appId");
  const { store, now } = await getContext();
  await unlockScopeAs(store, viewer, appId, field(form, "scopeId"), now());
  revalidatePath(`/apps/${appId}`, "layout");
}

export async function unlinkScopeAction(form: FormData): Promise<void> {
  const viewer = await requireMember();
  const appId = field(form, "appId");
  const { store, now } = await getContext();
  await unlinkScopeAs(store, viewer, appId, field(form, "scopeId"), now());
  revalidatePath(`/apps/${appId}`, "layout");
}

export async function deleteAppAction(form: FormData): Promise<void> {
  const viewer = await requireMember();
  const { store, now } = await getContext();
  await deleteAppAs(store, viewer, field(form, "appId"), now());
  revalidatePath("/apps");
  redirect("/apps");
}
