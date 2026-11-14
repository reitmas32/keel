"use server";

import { isRole } from "@keel/shared";
import { revalidatePath } from "next/cache";
import { createTokenAs, revokeTokenAs } from "@/lib/admin";
import { getContext } from "@/lib/context";
import { ApiError } from "@/lib/errors";
import { rejectedAction } from "@/lib/log";
import { requireMember } from "../session";

export interface TokenFormState {
  error?: string;
  /** Plaintext API token, returned once right after it is created. */
  token?: string;
  name?: string;
}

/** Creates a token for the member signed in, optionally capped at a "rol máximo". */
export async function createApiTokenAction(_state: TokenFormState, form: FormData): Promise<TokenFormState> {
  const viewer = await requireMember();
  try {
    const { store, now } = await getContext();
    const maxRole = String(form.get("maxRole") ?? "");
    const { record, token } = await createTokenAs(
      store,
      viewer,
      { name: String(form.get("name") ?? ""), maxRole: isRole(maxRole) ? maxRole : null },
      now(),
    );
    revalidatePath("/tokens");
    return { token, name: record.name };
  } catch (error) {
    if (error instanceof ApiError) return rejectedAction("tokens", error);
    throw error;
  }
}

/** Members revoke their own tokens; admins anyone's (enforced in revokeTokenAs). */
export async function revokeApiTokenAction(form: FormData): Promise<void> {
  const viewer = await requireMember();
  const { store, now } = await getContext();
  await revokeTokenAs(store, viewer, String(form.get("tokenId") ?? ""), now());
  revalidatePath("/tokens");
}
