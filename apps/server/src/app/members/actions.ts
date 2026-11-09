"use server";

import { revalidatePath } from "next/cache";
import { actorOf } from "@/lib/access";
import { requireAdmin } from "@/lib/admin";
import { getContext } from "@/lib/context";
import { ApiError } from "@/lib/errors";
import {
  addMemberGrant,
  changeMemberRole,
  inviteMember,
  removeMemberGrant,
  resendInvite,
  setMemberEnabled,
} from "@/lib/members";
import { publicOrigin, requireMember, type Viewer } from "../session";

export interface MemberFormState {
  error?: string;
  /** The one-time invite link, returned once right after it is created. */
  inviteUrl?: string;
  name?: string;
  ok?: boolean;
}

const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

/** Every action here is for global admins only; errors (403, the last-admin guard…) become form state. */
async function asAdmin(fn: (viewer: Viewer) => Promise<MemberFormState>): Promise<MemberFormState> {
  const viewer = await requireMember();
  try {
    requireAdmin(viewer, "administrar miembros");
    const state = await fn(viewer);
    revalidatePath("/members", "layout");
    return state;
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    throw error;
  }
}

const inviteUrl = async (token: string) => `${await publicOrigin()}/invite/${token}`;

export async function inviteMemberAction(_state: MemberFormState, form: FormData): Promise<MemberFormState> {
  return asAdmin(async (viewer) => {
    const { store, now } = await getContext();
    const { member, token } = await inviteMember(
      store,
      actorOf(viewer),
      { name: field(form, "name"), email: field(form, "email"), role: field(form, "role") },
      now(),
    );
    return { inviteUrl: await inviteUrl(token), name: member.name };
  });
}

export async function resendInviteAction(memberId: string, _state: MemberFormState): Promise<MemberFormState> {
  return asAdmin(async (viewer) => {
    const { store, now } = await getContext();
    return { inviteUrl: await inviteUrl(await resendInvite(store, actorOf(viewer), memberId, now())) };
  });
}

export async function changeRoleAction(
  memberId: string,
  _state: MemberFormState,
  form: FormData,
): Promise<MemberFormState> {
  return asAdmin(async (viewer) => {
    const { store, now } = await getContext();
    await changeMemberRole(store, actorOf(viewer), memberId, field(form, "role"), now());
    return { ok: true };
  });
}

export async function setEnabledAction(
  memberId: string,
  enabled: boolean,
  _state: MemberFormState,
): Promise<MemberFormState> {
  return asAdmin(async (viewer) => {
    const { store, now } = await getContext();
    await setMemberEnabled(store, actorOf(viewer), memberId, enabled, now());
    return { ok: true };
  });
}

export async function addGrantAction(
  memberId: string,
  _state: MemberFormState,
  form: FormData,
): Promise<MemberFormState> {
  return asAdmin(async (viewer) => {
    const { store, now } = await getContext();
    await addMemberGrant(
      store,
      actorOf(viewer),
      memberId,
      { repo: field(form, "repo"), service: field(form, "service"), role: field(form, "role") },
      now(),
    );
    return { ok: true };
  });
}

export async function removeGrantAction(grantId: string, _state: MemberFormState): Promise<MemberFormState> {
  return asAdmin(async (viewer) => {
    const { store, now } = await getContext();
    await removeMemberGrant(store, actorOf(viewer), grantId, now());
    return { ok: true };
  });
}
