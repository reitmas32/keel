"use server";

import { redirect } from "next/navigation";
import { getContext } from "@/lib/context";
import { ApiError } from "@/lib/errors";
import { acceptInvite } from "@/lib/members";
import { startSession } from "../../session";

export interface InviteState {
  error?: string;
}

/** Sets the invited member's password, activates it and signs it in. */
export async function acceptInviteAction(token: string, _state: InviteState, form: FormData): Promise<InviteState> {
  const { store, now } = await getContext();
  let memberId: string;
  try {
    const member = await acceptInvite(
      store,
      { token, password: String(form.get("password") ?? ""), confirm: String(form.get("confirm") ?? "") },
      now(),
    );
    memberId = member.id;
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    throw error;
  }
  await startSession(memberId);
  redirect("/scopes");
}
