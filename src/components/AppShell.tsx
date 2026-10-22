"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Icon, type IconName } from "./icons";
import { SessionProvider } from "./session";
import { Kbd, Modal, ToastProvider, useToast } from "./ui";
import { isModalOpen, isTypingTarget, matchesPlainKey } from "@/lib/shortcuts";
import { isReadOnlyRole, ROLE_LABELS, type SessionUser } from "@/lib/types";

const NAV: Array<{
  href: string;
  label: string;
  icon: IconName;
  shortcut?: string;
  adminOnly?: boolean;
}> = [
  { href: "/dashboard", label: "Dashboard", icon: "grid", shortcut: "D" },
  { href: "/inventory", label: "Inventory", icon: "box", shortcut: "I" },
  { href: "/transactions", label: "Transactions", icon: "swap", shortcut: "T" },
  { href: "/warehouses", label: "Warehouses", icon: "warehouse", shortcut: "W" },
  { href: "/users", label: "Users", icon: "users", adminOnly: true },
];

const NAV_SHORTCUTS: Array<{ key: string; href: string }> = [
  { key: "d", href: "/dashboard" },
  { key: "i", href: "/inventory" },
  { key: "t", href: "/transactions" },
  { key: "w", href: "/warehouses" },
];

function NavItems({
  user,
  mobile = false,
  onNavigate,
}: {
  user: SessionUser;
  mobile?: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  return (
    <>
      {NAV.filter((n) => !n.adminOnly || user.role === "admin").map((n) => {
        // Match exact or sub-route (e.g. /warehouses/3 stays under Warehouses).
        const active =
          pathname === n.href ||
          (n.href !== "/dashboard" && pathname.startsWith(n.href + "/"));
        return (
          <Link
            key={n.href}
            href={n.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            aria-keyshortcuts={n.shortcut}
            title={n.shortcut ? `${n.label} (${n.shortcut})` : undefined}
            className={`motion-nav group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-[13px] font-semibold transition-colors ${
              active
                ? "bg-coal-soft text-paper"
                : "text-paper/55 hover:bg-coal-soft/60 hover:text-paper"
            }`}
          >
            {active ? (
              <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-[#7fc4b2]" />
            ) : null}
            <Icon
              name={n.icon}
              className={`h-4 w-4 shrink-0 ${active ? "text-[#7fc4b2]" : "text-paper/45 group-hover:text-paper/80"}`}
            />
            <span className="truncate">{n.label}</span>
            {!mobile && n.shortcut ? (
              <Kbd
                tone="coal"
                className={`ml-auto min-w-5 transition-colors ${
                  active
                    ? "border-[#7fc4b2]/30 bg-coal text-[#7fc4b2]"
                    : "border-coal-line/80 bg-coal-soft/50 text-paper/40 group-hover:border-coal-line group-hover:text-paper/75"
                }`}
              >
                {n.shortcut}
              </Kbd>
            ) : null}
          </Link>
        );
      })}
    </>
  );
}

function Sidebar({
  user,
  onClose,
  onOpenShortcuts,
  mobile = false,
}: {
  user: SessionUser;
  onClose?: () => void;
  onOpenShortcuts?: () => void;
  mobile?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  const initials = user.displayName
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <aside
      className={`flex flex-col bg-coal text-paper ${
        mobile
          ? "h-full w-[260px]"
          : "fixed inset-y-0 left-0 z-40 hidden w-[232px] lg:flex"
      }`}
    >
      <div className="flex items-center gap-2.5 px-5 pb-6 pt-6">
        <Image
          src="/starstock-logo.svg"
          alt=""
          width={1536}
          height={1101}
          className="h-9 w-auto shrink-0"
        />
        <div className="leading-none">
          <div className="font-display text-[15px] font-bold tracking-tight">Star Stock</div>
          <div className="mt-1 text-[10px] font-medium uppercase tracking-[0.14em] text-paper/40">
            Inventory control
          </div>
        </div>
      </div>

      <nav className="flex-1 space-y-1 px-3">
        <NavItems user={user} mobile={mobile} onNavigate={onClose} />
      </nav>

      {!mobile && onOpenShortcuts ? (
        <div className="px-3 pb-2">
          <button
            type="button"
            onClick={onOpenShortcuts}
            title="Keyboard shortcuts (?)"
            className="group flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[12px] font-medium text-paper/45 transition-colors hover:bg-coal-soft/60 hover:text-paper/80"
          >
            <Icon
              name="keyboard"
              className="h-3.5 w-3.5 shrink-0 text-paper/40 transition-colors group-hover:text-paper/75"
            />
            <span>Shortcuts</span>
            <Kbd
              tone="coal"
              className="ml-auto min-w-5 border-coal-line/80 bg-coal-soft/50 text-paper/40 transition-colors group-hover:border-coal-line group-hover:text-paper/75"
            >
              ?
            </Kbd>
          </button>
        </div>
      ) : null}

      <div className="border-t border-coal-line p-3">
        <div className="flex items-center gap-2.5 rounded-lg bg-coal-soft/70 p-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand text-[11px] font-bold">
            {initials}
          </span>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-[13px] font-semibold">{user.displayName}</div>
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-[#7fc4b2]">
              <span>{ROLE_LABELS[user.role]}</span>
              {isReadOnlyRole(user.role) ? (
                <span className="rounded-full bg-coal px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-paper/60 ring-1 ring-coal-line">
                  View only
                </span>
              ) : null}
            </div>
          </div>
          <button
            onClick={() => {
              toast.push("info", "Signing out…");
              signOut();
            }}
            className="rounded-md p-1.5 text-paper/45 transition-colors hover:bg-coal hover:text-paper"
            title="Sign out"
          >
            <Icon name="logout" className="h-4 w-4" />
          </button>
        </div>
      </div>
    </aside>
  );
}

function MobileShell({ user }: { user: SessionUser }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close the drawer whenever the route changes.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Lock background scroll while drawer is open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const initials = user.displayName
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <>
      {/* Top bar */}
      <header className="fixed inset-x-0 top-0 z-30 flex h-14 items-center justify-between border-b border-line bg-card/95 px-4 backdrop-blur lg:hidden">
        <button
          onClick={() => setOpen(true)}
          className="rounded-md p-2 text-ink-soft transition-colors hover:bg-ink/5"
          aria-label="Open menu"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            className="h-5 w-5"
            aria-hidden
          >
            <path d="M4 7h16" />
            <path d="M4 12h16" />
            <path d="M4 17h16" />
          </svg>
        </button>
        <div className="flex items-center gap-2">
          <Image
            src="/starstock-logo.svg"
            alt=""
            width={1536}
            height={1101}
            className="h-8 w-auto"
          />
          <span className="font-display text-[15px] font-bold tracking-tight">Star Stock</span>
        </div>
        <span
          className="flex h-8 w-8 items-center justify-center rounded-full bg-brand text-[10px] font-bold text-paper"
          title={`${user.displayName} · ${ROLE_LABELS[user.role]}`}
        >
          {initials}
        </span>
      </header>

      {/* Drawer */}
      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="fade-in absolute inset-0 bg-coal/60"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div className="drawer-in absolute inset-y-0 left-0 flex">
            <Sidebar user={user} mobile onClose={() => setOpen(false)} />
          </div>
        </div>
      ) : null}
    </>
  );
}

function ShortcutRow({ label, keys }: { label: string; keys: string[] }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <span className="text-[13px] text-ink">{label}</span>
      <span className="flex shrink-0 items-center gap-1">
        {keys.map((k, idx) => (
          <span key={k} className="inline-flex items-center gap-1">
            {idx > 0 ? <span className="text-[11px] font-semibold text-ink-faint">+</span> : null}
            <Kbd tone="light" className="min-w-6 px-2 py-1 text-[11px]">
              {k}
            </Kbd>
          </span>
        ))}
      </span>
    </div>
  );
}

function ShortcutsModal({
  open,
  onClose,
  readOnly,
}: {
  open: boolean;
  onClose: () => void;
  readOnly: boolean;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Keyboard shortcuts"
      subtitle="Move across pages and record stock actions without leaving the keyboard."
      width="max-w-md"
    >
      <div className="space-y-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-ink-faint">
            Navigation · when not typing
          </p>
          <div className="mt-1.5 divide-y divide-line rounded-lg border border-line bg-card px-3.5">
            <ShortcutRow label="Dashboard" keys={["D"]} />
            <ShortcutRow label="Inventory" keys={["I"]} />
            <ShortcutRow label="Transactions" keys={["T"]} />
            <ShortcutRow label="Warehouses" keys={["W"]} />
          </div>
        </div>

        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-ink-faint">
            Inventory page
          </p>
          <div className="mt-1.5 divide-y divide-line rounded-lg border border-line bg-card px-3.5">
            <ShortcutRow label="Search product" keys={["Alt", "S"]} />
            {!readOnly ? <ShortcutRow label="Add product" keys={["Alt", "A"]} /> : null}
          </div>
        </div>

        {!readOnly ? (
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-ink-faint">
              Product page
            </p>
            <div className="mt-1.5 divide-y divide-line rounded-lg border border-line bg-card px-3.5">
              <ShortcutRow label="Inbound" keys={["Alt", "I"]} />
              <ShortcutRow label="Outbound" keys={["Alt", "O"]} />
            </div>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

export function AppShell({
  user,
  children,
}: {
  user: SessionUser;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const readOnly = isReadOnlyRole(user.role);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Allow Escape to leave an active page text input so single-key navigation
      // shortcuts can be used right away without reaching for the mouse.
      if (
        e.key === "Escape" &&
        !e.altKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        !isModalOpen() &&
        (document.activeElement instanceof HTMLInputElement ||
          document.activeElement instanceof HTMLTextAreaElement)
      ) {
        document.activeElement.blur();
        return;
      }

      // Single-key shortcuts only fire when not typing and no modal is open.
      if (isTypingTarget(e) || isModalOpen()) return;

      for (const nav of NAV_SHORTCUTS) {
        if (matchesPlainKey(e, nav.key)) {
          e.preventDefault();
          if (pathname !== nav.href) {
            router.push(nav.href);
          }
          return;
        }
      }

      if (
        e.key === "?" &&
        !e.altKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.repeat &&
        !e.defaultPrevented &&
        !e.isComposing
      ) {
        e.preventDefault();
        setShortcutsOpen(true);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pathname, router]);

  return (
    <ToastProvider>
      <SessionProvider user={user}>
        <MobileShell user={user} />
        <Sidebar user={user} onOpenShortcuts={() => setShortcutsOpen(true)} />
        <main className="min-h-screen pt-14 lg:ml-[232px] lg:pt-0">
          {readOnly ? (
            <div className="border-b border-line bg-adj-soft">
              <div className="mx-auto flex max-w-[1240px] items-center gap-2 px-4 py-2 text-[12px] font-semibold text-adj sm:px-6 lg:px-8">
                <Icon name="info" className="h-3.5 w-3.5 shrink-0" />
                Read-only access — you can view stock in every warehouse and download reports,
                but not make changes.
              </div>
            </div>
          ) : null}
          <div className="mx-auto max-w-[1240px] px-4 py-5 sm:px-6 sm:py-6 lg:px-8 lg:py-8">
            {children}
          </div>
        </main>
        <ShortcutsModal
          open={shortcutsOpen}
          onClose={() => setShortcutsOpen(false)}
          readOnly={readOnly}
        />
      </SessionProvider>
    </ToastProvider>
  );
}
