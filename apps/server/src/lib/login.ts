import { randomBytes } from "node:crypto";
import type { AccountsClient, AccountsFailureReason } from "./accounts";
import { checkPassword } from "./auth";
import { loginBreakGlass, loginWithAccounts, loginWithPassword } from "./members";
import { type Member, normalizeEmail, type Store } from "./store";

/**
 * The admin's login, independent of Next so it can be tested. With Accounts configured, a member signs in with their
 * Accounts email + password or with a code Accounts sends by email; keel's own member passwords still work as a
 * fallback (Accounts down, or a member without an Accounts account). Without Accounts, keel works as before. An
 * empty email with KEEL_ADMIN_PASSWORD is the break-glass access in both cases.
 */
export interface LoginDeps {
  store: Store;
  accounts: AccountsClient | null;
  adminPassword: string;
  now: Date;
}

export type LoginResult = { ok: true; member: Member } | { ok: false; error: string };

const BAD_CREDENTIALS = "Email o contraseña incorrectos.";
const NOT_A_MEMBER =
  "Tu cuenta existe en Accounts, pero no eres miembro de keel o tu acceso está deshabilitado. Pide a un admin de keel que te invite.";

const MESSAGES: Partial<Record<AccountsFailureReason, string>> = {
  mfa: "Tu cuenta de Accounts pide un segundo factor, que keel todavía no admite. Entra con tu contraseña de keel o pide ayuda a un admin.",
  try_later: "Demasiados intentos. Espera unos minutos y vuelve a probar.",
  disabled: "El código por correo no está activado en Accounts para keel. Entra con tu contraseña.",
  invalid_code: "Código incorrecto.",
  needs_new_code: "Ese código ya no sirve (venció, se usó o pediste otro). Pide uno nuevo.",
  unavailable: "Accounts no responde. Prueba con tu contraseña de keel o más tarde.",
};

export async function passwordLogin(deps: LoginDeps, rawEmail: string, password: string): Promise<LoginResult> {
  const email = normalizeEmail(rawEmail);
  if (!email) {
    const member = checkPassword(password, deps.adminPassword)
      ? await loginBreakGlass(deps.store, deps.now)
      : undefined;
    return member ? { ok: true, member } : { ok: false, error: "Contraseña incorrecta." };
  }

  let accountsError: string | undefined;
  if (deps.accounts) {
    const result = await deps.accounts.signIn(email, password);
    if (result.ok) {
      const member = await loginWithAccounts(deps.store, result, "accounts_password", deps.now);
      if (member) return { ok: true, member };
      accountsError = NOT_A_MEMBER;
    } else if (result.reason === "mfa" || result.reason === "try_later" || result.reason === "unavailable") {
      accountsError = MESSAGES[result.reason];
    }
  }

  // Fallback: keel's own password (also the only way without Accounts).
  const local = await loginWithPassword(deps.store, email, password, deps.now);
  if (local) return { ok: true, member: local };
  return { ok: false, error: accountsError ?? BAD_CREDENTIALS };
}

/**
 * Asks Accounts to email a code. Only for keel members who aren't disabled; for anyone else it answers the same way
 * without calling Accounts (a random challenge that no code redeems), so the page doesn't reveal who is a member.
 */
export async function requestLoginCode(
  deps: LoginDeps,
  rawEmail: string,
): Promise<{ ok: true; challengeId: string } | { ok: false; error: string }> {
  if (!deps.accounts) return { ok: false, error: "El acceso con código por correo no está configurado." };
  const email = normalizeEmail(rawEmail);
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) return { ok: false, error: "Escribe tu email." };
  const member = await deps.store.getMemberByEmail(email);
  if (!member || member.status === "disabled")
    return { ok: true, challengeId: `none_${randomBytes(16).toString("hex")}` };
  const result = await deps.accounts.requestEmailCode(email);
  if (!result.ok) return { ok: false, error: MESSAGES[result.reason] ?? "No se pudo enviar el código." };
  return { ok: true, challengeId: result.challengeId };
}

export async function claimLoginCode(deps: LoginDeps, challengeId: string, rawCode: string): Promise<LoginResult> {
  if (!deps.accounts) return { ok: false, error: "El acceso con código por correo no está configurado." };
  const code = rawCode.replace(/\s+/g, "");
  if (!challengeId || !code) return { ok: false, error: "Escribe el código que te llegó por correo." };
  if (challengeId.startsWith("none_")) return { ok: false, error: MESSAGES.invalid_code as string };
  const result = await deps.accounts.claimEmailCode(challengeId, code);
  if (!result.ok) {
    const left = result.remainingAttempts;
    const base = MESSAGES[result.reason] ?? "No se pudo entrar con ese código.";
    return {
      ok: false,
      error: result.reason === "invalid_code" && left !== undefined ? `${base} Te quedan ${left} intentos.` : base,
    };
  }
  const member = await loginWithAccounts(deps.store, result, "accounts_email_code", deps.now);
  return member ? { ok: true, member } : { ok: false, error: NOT_A_MEMBER };
}
