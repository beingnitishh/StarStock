"use client";

import { usePathname, useRouter } from "next/navigation";
import { Icon, type IconName } from "./icons";
import { ToastProvider, useToast } from "./ui";
import { ROLE_LABELS, type SessionUser } from "@/lib/types";

const NAV: Array<{ href: string; label: string; icon: IconName; adminOnly?: boolean }> = [
  { href: "/dashboard", label: "Dashboard", icon: "grid" },
  { href: "/inventory", label: "Inventory", icon: "box" },
  { href: "/transactions", label: "Transactions", icon: "swap" },
  { href: "/warehouses", label: "Warehouses", icon: "warehouse" },
  { href: "/users", label: "Users", icon: "users", adminOnly: true },
];

function Sidebar({ user }: { user: SessionUser }) {
  const pathname = usePathname();
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
    <aside className="fixed inset-y-0 left-0 z-40 flex w-[232px] flex-col bg-coal text-paper">
      <div className="flex items-center gap-2.5 px-5 pb-6 pt-6">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand text-paper shadow-[0_0_0_1px_rgba(255,255,255,0.06)]">
          <Icon name="star" className="h-4 w-4" strokeWidth={2} />
        </span>
        <div className="leading-none">
          <div className="font-display text-[15px] font-bold tracking-tight">Star Stock</div>
          <div className="mt-1 text-[10px] font-medium uppercase tracking-[0.14em] text-paper/40">
            Inventory control
          </div>
        </div>
      </div>

      <nav className="flex-1 space-y-1 px-3">
        {NAV.filter((n) => !n.adminOnly || user.role === "admin").map((n) => {
          const active = pathname.startsWith(n.href);
          return (
            <a
              key={n.href}
              href={n.href}
              className={`group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-[13px] font-semibold transition-colors ${
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
                className={`h-4 w-4 ${active ? "text-[#7fc4b2]" : "text-paper/45 group-hover:text-paper/80"}`}
              />
              {n.label}
            </a>
          );
        })}
      </nav>

      <div className="border-t border-coal-line p-3">
        <div className="flex items-center gap-2.5 rounded-lg bg-coal-soft/70 p-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand text-[11px] font-bold">
            {initials}
          </span>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-[13px] font-semibold">{user.displayName}</div>
            <div className="text-[11px] text-[#7fc4b2]">{ROLE_LABELS[user.role]}</div>
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

export function AppShell({
  user,
  children,
}: {
  user: SessionUser;
  children: React.ReactNode;
}) {
  return (
    <ToastProvider>
      <Sidebar user={user} />
      <main className="ml-[232px] min-h-screen">
        <div className="mx-auto max-w-[1240px] px-8 py-8">{children}</div>
      </main>
    </ToastProvider>
  );
}
