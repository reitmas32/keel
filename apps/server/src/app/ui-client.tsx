"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useState } from "react";
import {
  IconApps,
  IconAudit,
  IconCheck,
  IconCopy,
  IconKey,
  IconLayers,
  IconRocket,
  IconSettings,
  IconTag,
  IconUsers,
} from "./icons";

const NAV = [
  { href: "/apps", label: "Apps", icon: <IconApps /> },
  { href: "/tokens", label: "Tokens de API", icon: <IconKey /> },
  { href: "/members", label: "Miembros", icon: <IconUsers />, admin: true },
  { href: "/audit", label: "Auditoría", icon: <IconAudit />, admin: true },
];

/** The sidebar links; the one for the current section is highlighted. Members and audit only show to admins. */
export function NavLinks({ admin }: { admin: boolean }) {
  const pathname = usePathname();
  return (
    <ul className="sidebar-nav">
      {NAV.filter((item) => admin || !item.admin).map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <li key={item.href}>
            <Link href={item.href} className="nav-item" aria-current={active ? "page" : undefined}>
              {item.icon}
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export const APP_SECTIONS = [
  { slug: "scopes", label: "Scopes", icon: <IconLayers /> },
  { slug: "versions", label: "Versiones", icon: <IconTag /> },
  { slug: "deploys", label: "Deploys", icon: <IconRocket /> },
  { slug: "settings", label: "Configuración", icon: <IconSettings /> },
] as const;

export type AppSection = (typeof APP_SECTIONS)[number]["slug"];

/**
 * While an app is open (`/apps/<id>/…`), a sidebar group with its sections, the way Dokploy shows a project's
 * services. The app's name comes from the server; the id from the URL.
 */
export function AppNav({ apps }: { apps: { id: string; name: string }[] }) {
  const pathname = usePathname();
  const match = pathname.match(/^\/apps\/([^/]+)(?:\/([^/]+))?/);
  const app = match && apps.find((a) => a.id === match[1]);
  if (!app) return null;
  const current = match?.[2] ?? "scopes";
  return (
    <nav className="sidebar-group sidebar-app" aria-label={`Secciones de ${app.name}`}>
      <div className="sidebar-label" title={app.name}>
        {app.name}
      </div>
      <ul className="sidebar-nav">
        {APP_SECTIONS.map((section) => (
          <li key={section.slug}>
            <Link
              href={`/apps/${app.id}/${section.slug}`}
              className="nav-item"
              aria-current={current === section.slug ? "page" : undefined}
            >
              {section.icon}
              {section.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-outline btn-sm"
      onClick={() => navigator.clipboard.writeText(value).then(() => setCopied(true))}
    >
      {copied ? <IconCheck /> : <IconCopy />}
      {copied ? "Copiado" : "Copiar"}
    </button>
  );
}

/** A freshly generated secret, shown once with a copy button. */
export function TokenNotice({
  token,
  hint,
  title = "Guarda este token ahora: no se vuelve a mostrar.",
  children,
}: {
  token: string;
  hint: ReactNode;
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div className="alert" role="status">
      <strong className="alert-title">{title}</strong>
      <div>{hint}</div>
      <div className="token-row">
        <code>{token}</code>
        <CopyButton value={token} />
      </div>
      {children}
    </div>
  );
}

/** A submit button that asks for confirmation before a destructive form action runs. */
export function ConfirmButton({
  message,
  children,
  variant = "destructive",
}: {
  message: string;
  children: ReactNode;
  variant?: "destructive" | "outline";
}) {
  return (
    <button
      type="submit"
      className={`btn btn-${variant} btn-sm`}
      onClick={(e) => {
        if (!confirm(message)) e.preventDefault();
      }}
    >
      {children}
    </button>
  );
}
