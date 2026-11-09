"use server";

import { revalidatePath } from "next/cache";
import { createApiToken } from "@/lib/api-auth";
import { getContext } from "@/lib/context";
import { ApiError } from "@/lib/errors";
import { requireAdmin } from "../session";

export interface TokenFormState {
  error?: string;
  /** Plaintext API token, returned once right after it is created. */
  token?: string;
  name?: string;
}

export async function createApiTokenAction(_state: TokenFormState, form: FormData): Promise<TokenFormState> {
  await requireAdmin();
  try {
    const { store, now } = await getContext();
    const { record, token } = await createApiToken(store, String(form.get("name") ?? ""), now());
    revalidatePath("/tokens");
    return { token, name: record.name };
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    throw error;
  }
}

export async function revokeApiTokenAction(form: FormData): Promise<void> {
  await requireAdmin();
  await (await getContext()).store.deleteApiToken(String(form.get("tokenId") ?? ""));
  revalidatePath("/tokens");
}
