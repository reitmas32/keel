import type { ReactNode } from "react";

/** A 24×24 stroke icon. Decorative: the text next to it carries the meaning. */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** keel's mark: a hull seen from the bow with its keel below the waterline. */
export function KeelMark() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3.5 8.5h17l-3 6h-11z" fill="currentColor" />
      <path d="M12 14.5v6.5" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" />
      <path d="M2 5.5c2-1.3 4-1.3 6 0s4 1.3 6 0 4-1.3 6 0" stroke="currentColor" strokeWidth="1.5" opacity=".6" />
    </svg>
  );
}

export const IconScopes = () => (
  <Icon>
    <path d="M12 3 3 7.5l9 4.5 9-4.5z" />
    <path d="m3 12 9 4.5 9-4.5" />
    <path d="m3 16.5 9 4.5 9-4.5" />
  </Icon>
);

export const IconKey = () => (
  <Icon>
    <circle cx="7.5" cy="15.5" r="4.5" />
    <path d="m10.7 12.3 9.8-9.8" />
    <path d="m17 6 3 3" />
    <path d="m14.5 8.5 2 2" />
  </Icon>
);

export const IconLogOut = () => (
  <Icon>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="m16 17 5-5-5-5" />
    <path d="M21 12H9" />
  </Icon>
);

export const IconLock = () => (
  <Icon>
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </Icon>
);

export const IconUnlock = () => (
  <Icon>
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 7.9-1" />
  </Icon>
);

export const IconChevronRight = () => (
  <svg className="icon sep" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="m9 18 6-6-6-6" />
  </svg>
);

export const IconExternal = () => (
  <Icon>
    <path d="M15 3h6v6" />
    <path d="M10 14 21 3" />
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  </Icon>
);

export const IconPlus = () => (
  <Icon>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </Icon>
);

export const IconCopy = () => (
  <Icon>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2" />
  </Icon>
);

export const IconCheck = () => (
  <Icon>
    <path d="M20 6 9 17l-5-5" />
  </Icon>
);

export const IconTrash = () => (
  <Icon>
    <path d="M3 6h18" />
    <path d="M8 6V4h8v2" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
  </Icon>
);

export const IconRefresh = () => (
  <Icon>
    <path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" />
    <path d="M3 21v-5h5" />
    <path d="M3 12a9 9 0 0 1 15.5-6.2L21 8" />
    <path d="M21 3v5h-5" />
  </Icon>
);

export const IconServer = () => (
  <Icon>
    <rect x="3" y="3" width="18" height="7" rx="2" />
    <rect x="3" y="14" width="18" height="7" rx="2" />
    <path d="M7 6.5h.01" />
    <path d="M7 17.5h.01" />
  </Icon>
);

export const IconRepo = () => (
  <Icon>
    <path d="M4 19.5V5a2 2 0 0 1 2-2h14v15H6.5a2.5 2.5 0 0 0 0 5H20" />
  </Icon>
);
