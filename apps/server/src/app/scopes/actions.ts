"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getContext } from "@/lib/context";
import { ApiError } from "@/lib/errors";
import { addService, createScope, rotateCiToken } from "@/lib/scopes";
import { requireAdmin } from "../session";

export interface FormState {
  error?: string;
  /** Plaintext CI token, returned once right after it is generated. */
  token?: string;
  scopeId?: string;
  repo?: string;
}

const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

/** Runs a mutation and turns expected errors into form state instead of an error page. */
async function attempt(fn: () => FormState | Promise<FormState>): Promise<FormState> {
  await requireAdmin();
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    throw error;
  }
}

export async function createScopeAction(_state: FormState, form: FormData): Promise<FormState> {
  return attempt(() => {
    const { store, now } = getContext();
    const { scope, ciToken } = createScope(
      store,
      { name: field(form, "name"), repoUrl: field(form, "repoUrl") },
      now(),
    );
    revalidatePath("/scopes");
    return { token: ciToken, scopeId: scope.id, repo: scope.repo };
  });
}

export async function addServiceAction(scopeId: string, _state: FormState, form: FormData): Promise<FormState> {
  return attempt(() => {
    const { store, now } = getContext();
    const scope = store.getScope(scopeId);
    if (!scope) throw new ApiError(404, "Scope no encontrado.");
    addService(store, scope, { alias: field(form, "alias"), dokployUrl: field(form, "dokployUrl") }, now());
    revalidatePath(`/scopes/${scopeId}`);
    return {};
  });
}

export async function rotateTokenAction(scopeId: string, _state: FormState): Promise<FormState> {
  return attempt(() => ({ token: rotateCiToken(getContext().store, scopeId) }));
}

export async function deleteServiceAction(form: FormData): Promise<void> {
  await requireAdmin();
  const scopeId = field(form, "scopeId");
  const service = getContext().store.getService(field(form, "serviceId"));
  if (service?.scopeId === scopeId) getContext().store.deleteService(service.id);
  revalidatePath(`/scopes/${scopeId}`);
}

export async function deleteScopeAction(form: FormData): Promise<void> {
  await requireAdmin();
  getContext().store.deleteScope(field(form, "scopeId"));
  revalidatePath("/scopes");
  redirect("/scopes");
}
