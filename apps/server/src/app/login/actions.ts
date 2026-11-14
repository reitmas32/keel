"use server";

import { setTimeout as sleep } from "node:timers/promises";
import { redirect } from "next/navigation";
import { getContext } from "@/lib/context";
import { claimLoginCode, type LoginDeps, passwordLogin, requestLoginCode } from "@/lib/login";
import { endSession, startSession } from "../session";

export interface LoginState {
  error?: string;
  email?: string;
}

export interface CodeState {
  error?: string;
  email?: string;
  /** Set once the code was asked for: the form then asks for the code. */
  challengeId?: string;
}

async function deps(): Promise<LoginDeps> {
  const { env, store, accounts, now } = await getContext();
  return { store, accounts, adminPassword: env.KEEL_ADMIN_PASSWORD, now: now() };
}

/**
 * Email + password: Accounts first when it is configured, keel's own member password as the fallback. Without an
 * email, the password is checked against KEEL_ADMIN_PASSWORD (break-glass). See lib/login.ts.
 */
export async function login(_state: LoginState, form: FormData): Promise<LoginState> {
  const email = String(form.get("email") ?? "").trim();
  const result = await passwordLogin(await deps(), email, String(form.get("password") ?? ""));
  if (!result.ok) {
    // Slows down password guessing without keeping any state.
    await sleep(750);
    return { error: result.error, email };
  }
  await startSession(result.member.id);
  redirect("/apps");
}

/** Step 1 of the code login: Accounts emails a code. Step 2 (with `challengeId`): redeem it and sign in. */
export async function loginWithCode(state: CodeState, form: FormData): Promise<CodeState> {
  const d = await deps();
  if (!state.challengeId || form.get("restart") === "1") {
    const email = String(form.get("email") ?? "").trim();
    if (form.get("restart") === "1") return { email };
    const requested = await requestLoginCode(d, email);
    return requested.ok ? { email, challengeId: requested.challengeId } : { email, error: requested.error };
  }
  const result = await claimLoginCode(d, state.challengeId, String(form.get("code") ?? ""));
  if (!result.ok) {
    await sleep(500);
    return { ...state, error: result.error };
  }
  await startSession(result.member.id);
  redirect("/apps");
}

export async function logout(): Promise<void> {
  await endSession();
  redirect("/login");
}
