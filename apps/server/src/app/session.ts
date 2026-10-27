import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { createSession, SESSION_COOKIE, SESSION_HOURS, verifySession } from "@/lib/auth";
import { getContext } from "@/lib/context";

/** Redirects to /login unless the request carries a valid admin session. Call it in every admin page and action. */
export async function requireAdmin(): Promise<void> {
  const value = (await cookies()).get(SESSION_COOKIE)?.value;
  const { env, now } = getContext();
  if (!verifySession(value, env.KEEL_ADMIN_PASSWORD, now())) redirect("/login");
}

export async function startSession(): Promise<void> {
  const { env, now } = getContext();
  // Behind Dokploy's Traefik the original scheme arrives in x-forwarded-proto.
  const secure = (await headers()).get("x-forwarded-proto") === "https";
  (await cookies()).set(SESSION_COOKIE, createSession(env.KEEL_ADMIN_PASSWORD, now()), {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: SESSION_HOURS * 3600,
  });
}

export async function endSession(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}
