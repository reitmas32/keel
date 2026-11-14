"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  createAppAs,
  decideDeployAs,
  deleteAppAs,
  linkScopeAs,
  lockScopeAs,
  rotateCiTokenAs,
  setAppRequireApprovalAs,
  unlinkScopeAs,
  unlockScopeAs,
  updateScopeAs,
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
    return { ok: true };
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

const numberField = (form: FormData, name: string) => {
  const value = field(form, name);
  return value === "" ? undefined : Number(value);
};

/** The scope's health check and automatic rollback, from its settings form. */
export async function updateScopeAction(
  appId: string,
  scopeId: string,
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  return attempt(async (viewer) => {
    const { store, now } = await getContext();
    const enabled = form.get("healthEnabled") === "on";
    const url = field(form, "healthUrl");
    const expectedStatus = numberField(form, "healthStatus");
    await updateScopeAs(
      store,
      viewer,
      appId,
      scopeId,
      {
        // Off and without a URL there is nothing worth keeping.
        healthCheck:
          !enabled && !url
            ? null
            : {
                enabled,
                url,
                expectedStatus: expectedStatus ?? null,
                retries: numberField(form, "healthRetries"),
                intervalSeconds: numberField(form, "healthInterval"),
                timeoutSeconds: numberField(form, "healthTimeout"),
              },
        autoRollback: form.get("autoRollback") === "on",
        // "" follows the app; "1"/"0" overrides it.
        requireApproval: field(form, "requireApproval") === "" ? null : field(form, "requireApproval") === "1",
      },
      now(),
    );
    revalidatePath(`/apps/${appId}`, "layout");
    return { ok: true };
  });
}

/** Approves or rejects a deploy waiting for a second member. A rejection needs a reason. */
export async function decideDeployAction(
  appId: string,
  deployId: string,
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  return attempt(async (viewer) => {
    const { store, notifier, now } = await getContext();
    const decision = field(form, "decision") === "reject" ? "rejected" : "approved";
    const deploy = await decideDeployAs(store, viewer, appId, deployId, decision, field(form, "reason"), now());
    notifier.notify({
      event: decision === "approved" ? "deploy.approved" : "deploy.rejected",
      deploy,
      actor: viewer.member.name,
      detail: deploy.approval?.reason ?? null,
    });
    revalidatePath(`/apps/${appId}`, "layout");
    return { ok: true };
  });
}

export async function setAppApprovalAction(appId: string, _state: FormState, form: FormData): Promise<FormState> {
  return attempt(async (viewer) => {
    const { store, now } = await getContext();
    await setAppRequireApprovalAs(store, viewer, appId, form.get("requireApproval") === "on", now());
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

export type ScopeSetting = "healthEnabled" | "autoRollback" | "requireApproval";

/**
 * One setting of a scope, changed from its row in the scopes table. Sends only that field, so the others stay as
 * they are; the health check can only be switched once it has a URL.
 */
export async function setScopeSettingAction(
  appId: string,
  scopeId: string,
  setting: ScopeSetting,
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  return attempt(async (viewer) => {
    const { store, now } = await getContext();
    const value = field(form, "value");
    let change: Record<string, unknown>;
    if (setting === "autoRollback") change = { autoRollback: value === "1" };
    else if (setting === "requireApproval") change = { requireApproval: value === "" ? null : value === "1" };
    else {
      const scope = await store.getScope(scopeId);
      if (!scope?.healthCheck?.url) throw new ApiError(400, "Configura primero la URL del health check.");
      change = { healthCheck: { ...scope.healthCheck, enabled: value === "1" } };
    }
    await updateScopeAs(store, viewer, appId, scopeId, change, now());
    revalidatePath(`/apps/${appId}`, "layout");
    return { ok: true };
  });
}
