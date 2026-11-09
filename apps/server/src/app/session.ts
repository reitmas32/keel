import "server-only";
import type { Role } from "@keel/shared";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { isAdmin, memberPrincipal, type Principal, requireRoleOn } from "@/lib/access";
import { requireAdmin as requireGlobalAdmin } from "@/lib/admin";
import { createSession, SESSION_COOKIE, SESSION_HOURS, verifySession } from "@/lib/auth";
import { getContext } from "@/lib/context";
import type { Target } from "@/lib/roles";
import type { Member } from "@/lib/store";

/** The member signed in to the admin, with its grants. */
export interface Viewer extends Principal {
  member: Member;
}

/**
 * The active member behind the session cookie, or undefined. A disabled (or deleted) member counts as signed out.
 * Cached per request, so the layout and the page read it once.
 */
export const currentViewer = cache(async (): Promise<Viewer | undefined> => {
  const value = (await cookies()).get(SESSION_COOKIE)?.value;
  const { env, store, now } = await getContext();
  const memberId = verifySession(value, env.KEEL_ADMIN_PASSWORD, now());
  const member = memberId ? await store.getMember(memberId) : undefined;
  if (member?.status !== "active") return undefined;
  return (await memberPrincipal(store, member)) as Viewer;
});

/** Redirects to /login unless an active member is signed in. Call it in every admin page and action. */
export async function requireMember(): Promise<Viewer> {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");
  return viewer;
}

/**
 * Like requireMember, and also needs `role`: on `target` when given, else as base role (only `admin` needs that:
 * members, audit, everyone's tokens). Throws ApiError 403, which actions turn into a form error; pages pass
 * `{ redirect: true }` to go back to /apps instead.
 */
export async function requireRole(
  role: Role,
  target?: Target,
  { redirect: toApps = false, action = "hacer esto" }: { redirect?: boolean; action?: string } = {},
): Promise<Viewer> {
  const viewer = await requireMember();
  try {
    if (target) requireRoleOn(viewer, role, action, target);
    else if (role === "admin") requireGlobalAdmin(viewer, action);
  } catch (error) {
    if (toApps) redirect("/apps");
    throw error;
  }
  return viewer;
}

export const viewerIsAdmin = (viewer: Viewer) => isAdmin(viewer);

export async function startSession(memberId: string): Promise<void> {
  const { env, now } = await getContext();
  // Behind Dokploy's Traefik the original scheme arrives in x-forwarded-proto.
  const secure = (await headers()).get("x-forwarded-proto") === "https";
  (await cookies()).set(SESSION_COOKIE, createSession(memberId, env.KEEL_ADMIN_PASSWORD, now()), {
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

/** `https://keel.example.com` as the browser sees it, for links shown in the admin. */
export async function publicOrigin(): Promise<string> {
  const h = await headers();
  return `${h.get("x-forwarded-proto") ?? "http"}://${h.get("x-forwarded-host") ?? h.get("host")}`;
}
