"use server";

import { setTimeout as sleep } from "node:timers/promises";
import { redirect } from "next/navigation";
import { checkPassword } from "@/lib/auth";
import { getContext } from "@/lib/context";
import { endSession, startSession } from "../session";

export interface LoginState {
  error?: string;
}

export async function login(_state: LoginState, form: FormData): Promise<LoginState> {
  const password = String(form.get("password") ?? "");
  if (!checkPassword(password, getContext().env.KEEL_ADMIN_PASSWORD)) {
    // Slows down password guessing without keeping any state.
    await sleep(750);
    return { error: "Contraseña incorrecta." };
  }
  await startSession();
  redirect("/scopes");
}

export async function logout(): Promise<void> {
  await endSession();
  redirect("/login");
}
