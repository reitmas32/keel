"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useState } from "react";
import { IconCheck, IconCopy, IconKey, IconScopes } from "./icons";

const NAV = [
  { href: "/scopes", label: "Scopes", icon: <IconScopes /> },
  { href: "/tokens", label: "Tokens de API", icon: <IconKey /> },
];

/** The sidebar links; the one for the current section is highlighted. */
export function NavLinks() {
  const pathname = usePathname();
  return (
    <ul className="sidebar-nav">
      {NAV.map((item) => {
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
export function TokenNotice({ token, hint, children }: { token: string; hint: ReactNode; children?: ReactNode }) {
  return (
    <div className="alert" role="status">
      <strong className="alert-title">Guarda este token ahora: no se vuelve a mostrar.</strong>
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
