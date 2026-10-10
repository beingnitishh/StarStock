"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/icons";
import {
  Button,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  useToast,
} from "@/components/ui";
import { fmtDate } from "@/lib/units";
import { ROLE_LABELS, type Role } from "@/lib/types";

type UserRow = {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  createdAt: string;
};

const ROLE_BADGE: Record<Role, string> = {
  admin: "bg-brand-soft text-brand-deep",
  stock_head: "bg-move-soft text-move",
  stock_boy: "bg-adj-soft text-adj",
};

export default function UsersPage() {
  const toast = useToast();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [open, setOpen] = useState(false);

  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("stock_boy");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/users");
      if (res.status === 403) {
        setForbidden(true);
        return;
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load users.");
      setUsers(data.users ?? []);
    } catch (e) {
      toast.push("error", "Failed to load users", e instanceof Error ? e.message : undefined);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, displayName, password, role }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not create user.");
      toast.push("success", "User created", `${data.user.username} · ${ROLE_LABELS[data.user.role as Role]}`);
      setOpen(false);
      setUsername("");
      setDisplayName("");
      setPassword("");
      setRole("stock_boy");
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create user.");
      setBusy(false);
    }
  }

  if (forbidden) {
    return (
      <div className="mx-auto max-w-md pt-16">
        <EmptyState
          icon="alert"
          title="Admin access required"
          text="Only Admin can view or create user accounts. Sign in with an Admin account to manage users."
        />
      </div>
    );
  }

  return (
    <div className="rise-in space-y-5">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Users</h1>
          <p className="mt-1 text-sm text-ink-faint">
            Manage sign-in accounts and roles. Only Admin can do this.
          </p>
        </div>
        <Button variant="primary" icon="plus" onClick={() => setOpen(true)}>
          Create user
        </Button>
      </div>

      <div className="grid gap-3 rounded-xl border border-line bg-card p-4 sm:grid-cols-3">
        {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
          <div key={r} className="rounded-lg bg-surface px-3.5 py-3 ring-1 ring-line">
            <p className="text-[11px] font-bold text-ink-soft">{ROLE_LABELS[r]}</p>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
              {r === "admin"
                ? "Full access, including user management."
                : "Products, inbound/outbound, transfers, adjustments and Excel export."}
            </p>
          </div>
        ))}
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-14 animate-pulse rounded-xl bg-ink/5" />
          ))}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-card">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-line bg-surface text-[10px] font-bold uppercase tracking-[0.12em] text-ink-faint">
                <th className="px-4 py-2.5">User</th>
                <th className="px-4 py-2.5">Username</th>
                <th className="px-4 py-2.5">Role</th>
                <th className="px-4 py-2.5">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {users.map((u) => (
                <tr key={u.id} className="transition-colors hover:bg-surface/70">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand text-[11px] font-bold text-paper">
                        {u.displayName
                          .split(/\s+/)
                          .map((p) => p[0])
                          .slice(0, 2)
                          .join("")
                          .toUpperCase()}
                      </span>
                      <span className="text-[13px] font-semibold">{u.displayName}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{u.username}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-bold ${ROLE_BADGE[u.role]}`}
                    >
                      {ROLE_LABELS[u.role]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-ink-soft">{fmtDate(u.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Create user"
        subtitle="The new user can sign in immediately with these credentials."
        width="max-w-md"
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Username" required hint="3-30 chars">
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value.toLowerCase())}
                placeholder="e.g. jsmith"
                maxLength={30}
                className="font-mono"
              />
            </Field>
            <Field label="Role" required>
              <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
                <option value="admin">Admin</option>
                <option value="stock_head">Stock Head</option>
                <option value="stock_boy">Stock Boy</option>
              </Select>
            </Field>
          </div>
          <Field label="Display name" required>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Jordan Smith"
              maxLength={60}
            />
          </Field>
          <Field label="Password" required hint="min 6 characters">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              maxLength={100}
            />
          </Field>

          {error ? (
            <div className="flex items-start gap-2 rounded-lg border border-out/30 bg-out-soft px-3 py-2.5 text-[13px] font-medium text-out">
              <Icon name="alert" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {error}
            </div>
          ) : null}

          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" icon="plus" onClick={create} loading={busy}>
              Create user
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
