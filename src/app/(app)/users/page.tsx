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
import { ROLE_DESCRIPTIONS, ROLE_LABELS, ROLES, type Role } from "@/lib/types";

type UserRow = {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  active: boolean;
  createdAt: string;
  deactivatedAt: string | null;
};

const ROLE_BADGE: Record<Role, string> = {
  admin: "bg-brand-soft text-brand-deep",
  stock_head: "bg-move-soft text-move",
  stock_boy: "bg-adj-soft text-adj",
  member: "bg-surface text-ink-soft ring-1 ring-line-strong",
};

export default function UsersPage() {
  const toast = useToast();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [meId, setMeId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState<UserRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [restoringId, setRestoringId] = useState<number | null>(null);

  const [passwordFor, setPasswordFor] = useState<UserRow | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [savingPassword, setSavingPassword] = useState(false);

  const [roleFor, setRoleFor] = useState<UserRow | null>(null);
  const [newRole, setNewRole] = useState<Role>("stock_boy");
  const [roleError, setRoleError] = useState<string | null>(null);
  const [savingRole, setSavingRole] = useState(false);

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
      setMeId(typeof data.me === "number" ? data.me : null);
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
    } finally {
      setBusy(false);
    }
  }

  async function patchActive(user: UserRow, active: boolean): Promise<boolean> {
    try {
      const res = await fetch(`/api/users/${user.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ active }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          data.error ?? (active ? "Could not restore user." : "Could not remove user."),
        );
      }
      toast.push(
        "success",
        active ? "User restored" : "User removed",
        `${data.user.displayName} · ${data.user.username}`,
      );
      load();
      return true;
    } catch (e) {
      toast.push(
        "error",
        active ? "Failed to restore user" : "Failed to remove user",
        e instanceof Error ? e.message : undefined,
      );
      return false;
    }
  }

  async function confirmRemove() {
    if (!removing) return;
    setSaving(true);
    const ok = await patchActive(removing, false);
    setSaving(false);
    if (ok) setRemoving(null);
  }

  async function restore(user: UserRow) {
    setRestoringId(user.id);
    await patchActive(user, true);
    setRestoringId(null);
  }

  function openPasswordModal(user: UserRow) {
    setPasswordFor(user);
    setNewPassword("");
    setPasswordError(null);
  }

  async function savePassword() {
    if (!passwordFor) return;
    setSavingPassword(true);
    setPasswordError(null);
    try {
      const res = await fetch(`/api/users/${passwordFor.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: newPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not update the password.");
      toast.push(
        "success",
        "Password updated",
        `${data.user.displayName} has been signed out of all devices.`,
      );
      setPasswordFor(null);
      setNewPassword("");
      load();
    } catch (e) {
      setPasswordError(
        e instanceof Error ? e.message : "Could not update the password.",
      );
    } finally {
      setSavingPassword(false);
    }
  }

  function openRoleModal(user: UserRow) {
    setRoleFor(user);
    setNewRole(user.role);
    setRoleError(null);
  }

  async function saveRole() {
    if (!roleFor) return;
    setSavingRole(true);
    setRoleError(null);
    try {
      const res = await fetch(`/api/users/${roleFor.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: newRole }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not change the role.");
      toast.push(
        "success",
        "Role updated",
        `${data.user.displayName} is now ${ROLE_LABELS[data.user.role as Role]}.`,
      );
      setRoleFor(null);
      load();
    } catch (e) {
      setRoleError(e instanceof Error ? e.message : "Could not change the role.");
    } finally {
      setSavingRole(false);
    }
  }

  if (forbidden) {
    return (
      <div className="mx-auto max-w-md pt-16">
        <EmptyState
          icon="alert"
          title="Admin access required"
          text="Only Admin can view or manage user accounts. Sign in with an Admin account to manage users."
        />
      </div>
    );
  }

  return (
    <div className="rise-in space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Users</h1>
          <p className="mt-1 text-sm text-ink-faint">
            Add sign-in accounts for new staff and remove them when they leave. Use the Member
            role for people who only need to see current warehouse stock. Only Admin can do
            this.
          </p>
        </div>
        <Button variant="primary" icon="plus" onClick={() => setOpen(true)}>
          Create user
        </Button>
      </div>

      <div className="grid gap-3 rounded-xl border border-line bg-card p-4 sm:grid-cols-2 xl:grid-cols-4">
        {ROLES.map((r) => (
          <div key={r} className="rounded-lg bg-surface px-3.5 py-3 ring-1 ring-line">
            <p className="flex items-center gap-2 text-[11px] font-bold text-ink-soft">
              {ROLE_LABELS[r]}
              {r === "member" ? (
                <span className="rounded-full bg-card px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-ink-faint ring-1 ring-line-strong">
                  Read-only
                </span>
              ) : null}
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
              {ROLE_DESCRIPTIONS[r]}
            </p>
          </div>
        ))}
      </div>

      <p className="flex items-start gap-2 text-xs leading-relaxed text-ink-faint">
        <Icon name="info" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        Removed users are signed out immediately and cannot log in. Their past stock activity
        stays in the history under their name. A removed username stays reserved, so give the
        new person a new username.
      </p>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-14 animate-pulse rounded-xl bg-ink/5" />
          ))}
        </div>
      ) : (
        <div className="-mx-4 overflow-x-auto rounded-none border-y border-line bg-card px-4 sm:mx-0 sm:overflow-hidden sm:rounded-xl sm:border sm:px-0">
          <table className="w-full min-w-[760px] text-left">
            <thead>
              <tr className="border-b border-line bg-surface text-[10px] font-bold uppercase tracking-[0.12em] text-ink-faint">
                <th className="px-4 py-2.5">User</th>
                <th className="px-4 py-2.5">Username</th>
                <th className="px-4 py-2.5">Role</th>
                <th className="px-4 py-2.5">Created</th>
                <th className="px-4 py-2.5 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {users.map((u) => (
                <tr key={u.id} className="transition-colors hover:bg-surface/70">
                  <td className={`px-4 py-3 ${u.active ? "" : "opacity-50"}`}>
                    <div className="flex items-center gap-3">
                      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand text-[11px] font-bold text-paper">
                        {u.displayName
                          .split(/\s+/)
                          .map((p) => p[0])
                          .slice(0, 2)
                          .join("")
                          .toUpperCase()}
                      </span>
                      <span className="min-w-0">
                        <span className="text-[13px] font-semibold">{u.displayName}</span>
                        {!u.active ? (
                          <span className="mt-0.5 block text-[11px] font-semibold text-out">
                            Removed{u.deactivatedAt ? ` · ${fmtDate(u.deactivatedAt)}` : ""}
                          </span>
                        ) : null}
                      </span>
                    </div>
                  </td>
                  <td
                    className={`px-4 py-3 font-mono text-xs ${u.active ? "" : "opacity-50"}`}
                  >
                    {u.username}
                  </td>
                  <td className={`px-4 py-3 ${u.active ? "" : "opacity-50"}`}>
                    <span
                      className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-bold ${ROLE_BADGE[u.role]}`}
                    >
                      {ROLE_LABELS[u.role]}
                    </span>
                  </td>
                  <td
                    className={`px-4 py-3 text-xs text-ink-soft ${u.active ? "" : "opacity-50"}`}
                  >
                    {fmtDate(u.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {u.id === meId ? (
                      <span className="text-xs font-semibold text-ink-faint">You</span>
                    ) : u.active ? (
                      <div className="flex flex-wrap items-center justify-end gap-1.5">
                        <Button
                          size="sm"
                          variant="ghost"
                          icon="pencil"
                          onClick={() => openPasswordModal(u)}
                        >
                          Password
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon="sliders"
                          onClick={() => openRoleModal(u)}
                        >
                          Role
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          icon="trash"
                          onClick={() => setRemoving(u)}
                        >
                          Remove
                        </Button>
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        icon="check"
                        loading={restoringId === u.id}
                        onClick={() => restore(u)}
                      >
                        Restore
                      </Button>
                    )}
                  </td>
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
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                    {r === "member" ? " (read-only)" : ""}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <p className="flex items-start gap-2 rounded-lg bg-surface px-3 py-2.5 text-[12px] leading-relaxed text-ink-soft ring-1 ring-line">
            <Icon name="info" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {ROLE_DESCRIPTIONS[role]}
          </p>
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

      <Modal
        open={removing !== null}
        onClose={() => {
          if (!saving) setRemoving(null);
        }}
        title="Remove user?"
        subtitle={removing ? `${removing.displayName} · ${removing.username}` : undefined}
        width="max-w-md"
      >
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-ink-soft">
            They will be signed out right away and can no longer log in. Everything they did
            stays in the history under their name. You can restore the account any time.
          </p>
          <p className="text-sm leading-relaxed text-ink-soft">
            Their username stays reserved, so create the replacement with a new username.
          </p>
          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <Button variant="ghost" onClick={() => setRemoving(null)} disabled={saving}>
              Cancel
            </Button>
            <Button variant="danger" icon="trash" onClick={confirmRemove} loading={saving}>
              Remove user
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={passwordFor !== null}
        onClose={() => {
          if (!savingPassword) setPasswordFor(null);
        }}
        title="Reset password"
        subtitle={
          passwordFor ? `${passwordFor.displayName} · ${passwordFor.username}` : undefined
        }
        width="max-w-md"
      >
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-ink-soft">
            Set a new password and share it with them. They will be signed out of every
            device right away and must use the new password next time.
          </p>
          <Field label="New password" required hint="6-100 characters">
            <Input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="••••••••"
              maxLength={100}
              autoComplete="new-password"
            />
          </Field>

          {passwordError ? (
            <div className="flex items-start gap-2 rounded-lg border border-out/30 bg-out-soft px-3 py-2.5 text-[13px] font-medium text-out">
              <Icon name="alert" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {passwordError}
            </div>
          ) : null}

          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <Button
              variant="ghost"
              onClick={() => setPasswordFor(null)}
              disabled={savingPassword}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              icon="check"
              onClick={savePassword}
              loading={savingPassword}
              disabled={newPassword.length < 6 || newPassword.length > 100}
            >
              Reset password
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={roleFor !== null}
        onClose={() => {
          if (!savingRole) setRoleFor(null);
        }}
        title="Change role"
        subtitle={roleFor ? `${roleFor.displayName} · ${roleFor.username}` : undefined}
        width="max-w-md"
      >
        <div className="space-y-4">
          <Field label="Role" required>
            <Select value={newRole} onChange={(e) => setNewRole(e.target.value as Role)}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                  {r === "member" ? " (read-only)" : ""}
                </option>
              ))}
            </Select>
          </Field>
          <p className="flex items-start gap-2 rounded-lg bg-surface px-3 py-2.5 text-[12px] leading-relaxed text-ink-soft ring-1 ring-line">
            <Icon name="info" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {ROLE_DESCRIPTIONS[newRole]}
          </p>

          {roleError ? (
            <div className="flex items-start gap-2 rounded-lg border border-out/30 bg-out-soft px-3 py-2.5 text-[13px] font-medium text-out">
              <Icon name="alert" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {roleError}
            </div>
          ) : null}

          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <Button variant="ghost" onClick={() => setRoleFor(null)} disabled={savingRole}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon="check"
              onClick={saveRole}
              loading={savingRole}
              disabled={roleFor !== null && newRole === roleFor.role}
            >
              Save role
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
