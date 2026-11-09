"use server";

import { setTimeout as sleep } from "node:timers/promises";
import { redirect } from "next/navigation";
import { checkPassword } from "@/lib/auth";
import { getContext } from "@/lib/context";
import { loginBreakGlass, loginWithPassword } from "@/lib/members";
import { endSession, startSession } from "../session";

export interface LoginState {
  error?: string;
  email?: string;
}

/**
 * Email + password for members. Without an email, the password is checked against KEEL_ADMIN_PASSWORD and signs in
 * as the bootstrap admin (break-glass access).
 */
export async function login(_state: LoginState, form: FormData): Promise<LoginState> {
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const { env, store, now } = await getContext();

  const member = email
    ? await loginWithPassword(store, email, password, now())
    : checkPassword(password, env.KEEL_ADMIN_PASSWORD)
      ? await loginBreakGlass(store, now())
      : undefined;
  if (!member) {
    // Slows down password guessing without keeping any state.
    await sleep(750);
    return { error: email ? "Email o contraseña incorrectos." : "Contraseña incorrecta.", email };
  }
  await startSession(member.id);
  redirect("/apps");
}

export async function logout(): Promise<void> {
  await endSession();
  redirect("/login");
}
