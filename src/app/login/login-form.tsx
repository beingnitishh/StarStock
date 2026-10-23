"use client";

import { useState, type FormEvent } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icons";
import { Button, Field, Input } from "@/components/ui";

export function LoginForm({ next }: { next?: string | null }) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shakeKey, setShakeKey] = useState(0);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Login failed.");
      // `next` is a same-origin path validated by the login page (used by the
      // OAuth consent flow to return to the authorize request).
      router.replace(next ?? "/dashboard");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed.");
      setShakeKey((k) => k + 1);
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-[440px_1fr]">
      {/* Brand panel */}
      <div className="relative hidden flex-col justify-between overflow-hidden bg-coal p-10 text-paper lg:flex">
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage:
              "radial-gradient(circle at 1px 1px, #f2f1ea 1px, transparent 0)",
            backgroundSize: "26px 26px",
          }}
        />
        <div className="relative flex items-center gap-2.5">
          <Image
            src="/starstock-logo.svg"
            alt=""
            width={1536}
            height={1101}
            className="h-9 w-auto shrink-0"
          />
          <span className="font-display text-lg font-bold tracking-tight">Star Stock</span>
        </div>

        <div className="relative">
          <h1 className="font-display text-4xl font-bold leading-[1.12] tracking-tight">
            Every piece,
            <br />
            every carton,
            <br />
            <span className="text-[#7fc4b2]">accounted for.</span>
          </h1>
          <div className="mt-10 space-y-5">
            {[
              { icon: "warehouse", text: "Per-warehouse stock with combined totals" },
              { icon: "swap", text: "Inbound, outbound, transfers and adjustments" },
              { icon: "clock", text: "Timestamped history for every movement" },
            ].map((f) => (
              <div key={f.icon} className="flex items-center gap-3 text-sm text-paper/75">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-coal-soft text-[#7fc4b2]">
                  <Icon name={f.icon as "swap"} className="h-4 w-4" />
                </span>
                {f.text}
              </div>
            ))}
          </div>
        </div>

        <p className="relative text-xs text-paper/40">
          Star Stock · Inventory control workspace
        </p>
      </div>

      {/* Form panel */}
      <div className="flex items-center justify-center bg-paper px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <Image
              src="/starstock-logo.svg"
              alt=""
              width={1536}
              height={1101}
              className="h-9 w-auto shrink-0"
            />
            <span className="font-display text-lg font-bold tracking-tight">Star Stock</span>
          </div>

          <h2 className="font-display text-2xl font-bold tracking-tight">Sign in</h2>
          <p className="mt-1 text-sm text-ink-faint">
            Use your Star Stock username and password.
          </p>

          <form onSubmit={submit} key={shakeKey} className={error ? "shake-x mt-6" : "mt-6"}>
            <div className="space-y-4">
              <Field label="Username" required>
                <Input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="e.g. admin"
                  autoComplete="username"
                  autoFocus
                />
              </Field>
              <Field label="Password" required>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="current-password"
                />
              </Field>
            </div>

            {error ? (
              <div className="mt-4 flex items-start gap-2 rounded-lg border border-out/30 bg-out-soft px-3 py-2.5 text-[13px] font-medium text-out">
                <Icon name="alert" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {error}
              </div>
            ) : null}

            <Button
              type="submit"
              variant="primary"
              loading={busy}
              className="mt-5 w-full py-2.5"
            >
              Sign in
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
