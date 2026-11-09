"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  createScopeAs,
  deleteScopeAs,
  linkServiceAs,
  lockServiceAs,
  rotateCiTokenAs,
  unlinkServiceAs,
  unlockServiceAs,
} from "@/lib/admin";
import { getContext } from "@/lib/context";
import { ApiError } from "@/lib/errors";
import { requireMember, type Viewer } from "../session";

export interface FormState {
  error?: string;
  /** Plaintext CI token, returned once right after it is generated. */
  token?: string;
  scopeId?: string;
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

export async function createScopeAction(_state: FormState, form: FormData): Promise<FormState> {
  return attempt(async (viewer) => {
    const { store, now } = await getContext();
    const { scope, ciToken } = await createScopeAs(
      store,
      viewer,
      { name: field(form, "name"), repoUrl: field(form, "repoUrl") },
      now(),
    );
    revalidatePath("/scopes");
    return { token: ciToken, scopeId: scope.id, repo: scope.repo };
  });
}

export async function addServiceAction(scopeId: string, _state: FormState, form: FormData): Promise<FormState> {
  return attempt(async (viewer) => {
    const { store, now } = await getContext();
    await linkServiceAs(
      store,
      viewer,
      scopeId,
      { alias: field(form, "alias"), dokployUrl: field(form, "dokployUrl"), tagVariable: field(form, "tagVariable") },
      now(),
    );
    revalidatePath(`/scopes/${scopeId}`);
    return {};
  });
}

export async function rotateTokenAction(scopeId: string, _state: FormState): Promise<FormState> {
  return attempt(async (viewer) => {
    const { store, now } = await getContext();
    return { token: await rotateCiTokenAs(store, viewer, scopeId, now()) };
  });
}

export async function lockServiceAction(
  scopeId: string,
  serviceId: string,
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  return attempt(async (viewer) => {
    const { store, now } = await getContext();
    await lockServiceAs(store, viewer, scopeId, serviceId, field(form, "reason"), now());
    revalidatePath(`/scopes/${scopeId}`);
    return { ok: true };
  });
}

// The form actions below have no form state to show an error in: their buttons only render for roles that can use
// them, so a 403 here means a crafted request and the error page is fine.

export async function unlockServiceAction(form: FormData): Promise<void> {
  const viewer = await requireMember();
  const scopeId = field(form, "scopeId");
  const { store, now } = await getContext();
  await unlockServiceAs(store, viewer, scopeId, field(form, "serviceId"), now());
  revalidatePath(`/scopes/${scopeId}`);
}

export async function deleteServiceAction(form: FormData): Promise<void> {
  const viewer = await requireMember();
  const scopeId = field(form, "scopeId");
  const { store, now } = await getContext();
  await unlinkServiceAs(store, viewer, scopeId, field(form, "serviceId"), now());
  revalidatePath(`/scopes/${scopeId}`);
}

export async function deleteScopeAction(form: FormData): Promise<void> {
  const viewer = await requireMember();
  const { store, now } = await getContext();
  await deleteScopeAs(store, viewer, field(form, "scopeId"), now());
  revalidatePath("/scopes");
  redirect("/scopes");
}
