"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ComponentPropsWithRef,
  type ReactNode,
} from "react";
import { TX_META, type TxType } from "@/lib/txmeta";
import { fmtInt, splitCartons } from "@/lib/units";
import { Icon, type IconName } from "./icons";

export { TX_META };
export type { TxType };

/* ---------------------------------- Toasts --------------------------------- */

export type ToastKind = "success" | "error" | "info";
type Toast = { id: number; kind: ToastKind; title: string; message?: string };

const ToastCtx = createContext<{
  push: (kind: ToastKind, title: string, message?: string) => void;
}>({ push: () => {} });

export function useToast() {
  return useContext(ToastCtx);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((kind: ToastKind, title: string, message?: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, kind, title, message }]);
    window.setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
    }, 4500);
  }, []);

  const styles: Record<ToastKind, { border: string; icon: IconName; color: string }> = {
    success: { border: "border-l-in", icon: "check-circle", color: "text-in" },
    error: { border: "border-l-out", icon: "alert", color: "text-out" },
    info: { border: "border-l-adj", icon: "info", color: "text-adj" },
  };

  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="pointer-events-none fixed bottom-5 right-5 z-[90] flex w-80 flex-col gap-2">
        {toasts.map((t) => {
          const s = styles[t.kind];
          return (
            <div
              key={t.id}
              className={`toast-in pointer-events-auto rounded-lg border border-line ${s.border} border-l-4 bg-card p-3 shadow-lg shadow-coal/10`}
            >
              <div className="flex items-start gap-2.5">
                <Icon name={s.icon} className={`mt-0.5 h-4 w-4 shrink-0 ${s.color}`} />
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold leading-snug">{t.title}</p>
                  {t.message ? (
                    <p className="mt-0.5 text-xs leading-snug text-ink-soft">{t.message}</p>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}

/* --------------------------------- Spinner --------------------------------- */

export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={`animate-spin ${className}`} aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/* --------------------------------- Buttons --------------------------------- */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "in" | "out";

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  className = "",
  children,
  disabled,
  ...rest
}: {
  variant?: ButtonVariant;
  size?: "sm" | "md";
  loading?: boolean;
  icon?: IconName;
} & ComponentPropsWithRef<"button">) {
  const base =
    "inline-flex items-center justify-center gap-1.5 rounded-lg font-semibold motion-button focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50";
  const sizes = size === "sm" ? "min-h-10 px-2.5 py-1.5 text-xs sm:min-h-0" : "px-3.5 py-2 text-[13px]";
  const variants: Record<ButtonVariant, string> = {
    primary: "bg-brand text-paper hover:bg-brand-deep shadow-sm",
    secondary:
      "border border-line-strong bg-card text-ink hover:border-brand/50 hover:bg-brand-soft/40",
    ghost: "text-ink-soft hover:bg-ink/5 hover:text-ink",
    danger: "bg-out text-paper hover:bg-out/90 shadow-sm",
    in: "bg-in text-paper hover:bg-in/90 shadow-sm",
    out: "bg-out text-paper hover:bg-out/90 shadow-sm",
  };
  return (
    <button className={`${base} ${sizes} ${variants[variant]} ${className}`} disabled={disabled || loading} {...rest}>
      {loading ? <Spinner className="h-3.5 w-3.5" /> : icon ? <Icon name={icon} className="h-3.5 w-3.5" /> : null}
      {children}
    </button>
  );
}

/* ---------------------------- Shortcut key badge ---------------------------- */

type KbdTone = "light" | "onBrand" | "coal";

export function Kbd({
  children,
  tone = "light",
  className = "",
}: {
  children: ReactNode;
  tone?: KbdTone;
  className?: string;
}) {
  const tones: Record<KbdTone, string> = {
    light:
      "border-line-strong bg-surface text-ink-soft shadow-[0_1px_0_0_var(--color-line-strong)]",
    onBrand: "border-paper/25 bg-paper/15 text-paper/90",
    coal: "border-coal-line bg-coal-soft/70 text-paper/55",
  };
  return (
    <kbd
      aria-hidden="true"
      className={`inline-flex items-center justify-center rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold leading-none ${tones[tone]} ${className}`}
    >
      {children}
    </kbd>
  );
}

/* ---------------------------------- Inputs ---------------------------------- */

const fieldCls =
  "w-full rounded-lg border border-line-strong bg-card px-3 py-2 text-sm text-ink outline-none motion-field placeholder:text-ink-faint focus:border-brand focus:ring-2 focus:ring-brand-ring/50";

export function Input(props: ComponentPropsWithRef<"input">) {
  const { className = "", ...rest } = props;
  return <input className={`${fieldCls} ${className}`} {...rest} />;
}

export function Textarea(props: ComponentPropsWithRef<"textarea">) {
  const { className = "", ...rest } = props;
  return <textarea className={`${fieldCls} resize-none ${className}`} {...rest} />;
}

export function Select(props: ComponentPropsWithRef<"select">) {
  const { className = "", children, ...rest } = props;
  return (
    <div className="relative">
      <select className={`${fieldCls} appearance-none pr-8 ${className}`} {...rest}>
        {children}
      </select>
      <Icon
        name="chevron-down"
        className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint"
      />
    </div>
  );
}

export function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-baseline justify-between text-xs font-semibold text-ink-soft">
        <span>
          {label}
          {required ? <span className="ml-0.5 text-out">*</span> : null}
        </span>
        {hint ? <span className="font-normal text-ink-faint">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

/* ---------------------------------- Modal ---------------------------------- */

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  width = "max-w-lg",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[70] flex items-end overflow-y-auto sm:items-start sm:justify-center sm:p-4 sm:pt-[8vh]">
      <div className="fade-in fixed inset-0 bg-coal/55" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal-in relative w-full rounded-t-xl border border-line bg-surface shadow-2xl shadow-coal/30 sm:rounded-xl ${width} max-h-[92vh] overflow-y-auto`}
      >
        <div className="sticky top-0 z-10 flex items-start justify-between border-b border-line bg-surface/95 px-4 py-4 backdrop-blur sm:px-5">
          <div className="min-w-0 pr-2">
            <h2 className="font-display text-base font-semibold tracking-tight">{title}</h2>
            {subtitle ? <p className="mt-0.5 text-xs text-ink-faint">{subtitle}</p> : null}
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-ink-faint transition-colors hover:bg-ink/5 hover:text-ink"
            aria-label="Close"
          >
            <Icon name="x" className="h-4 w-4" />
          </button>
        </div>
        <div className="px-4 py-4 sm:px-5">{children}</div>
      </div>
    </div>
  );
}

/* ---------------------------------- Chips ---------------------------------- */

export function TypeChip({ type }: { type: TxType }) {
  const m = TX_META[type];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${m.chip}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${m.dot}`} />
      {m.label}
    </span>
  );
}

/* ------------------------------- Stock display ------------------------------ */

export function StockAmount({
  pieces,
  per,
  align = "left",
}: {
  pieces: number;
  per: number;
  align?: "left" | "right";
}) {
  const { cartons, remainder } = splitCartons(pieces, Math.max(per, 1));
  const al = align === "right" ? "text-right" : "";
  if (per <= 1) {
    return (
      <div className={al}>
        <span className="font-mono text-[13px] font-semibold">{fmtInt(pieces)} PCS</span>
      </div>
    );
  }
  return (
    <div className={al}>
      <div className="font-mono text-[13px] font-semibold leading-tight">
        {fmtInt(cartons)} CTN
        {remainder > 0 ? <span className="text-ink-soft"> + {fmtInt(remainder)} PCS</span> : null}
      </div>
      <div className={`font-mono text-[11px] text-ink-faint ${al}`}>{fmtInt(pieces)} pcs total</div>
    </div>
  );
}

/* -------------------------------- Empty state ------------------------------- */

export function EmptyState({
  icon,
  title,
  text,
  action,
}: {
  icon: IconName;
  title: string;
  text?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong bg-surface/60 px-6 py-14 text-center">
      <div className="rounded-full bg-brand-soft p-3 text-brand">
        <Icon name={icon} className="h-5 w-5" />
      </div>
      <p className="font-display text-sm font-semibold">{title}</p>
      {text ? <p className="max-w-sm text-xs leading-relaxed text-ink-faint">{text}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/* ------------------------------- Product thumb ------------------------------ */

export function ProductThumb({
  src,
  name,
  size = "h-10 w-10",
  rounded = "rounded-lg",
}: {
  src: string;
  name: string;
  size?: string;
  rounded?: string;
}) {
  // Remember which URL failed so a new image gets a fresh attempt without an
  // extra render cascade.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showImage = Boolean(src) && failedSrc !== src;

  if (showImage) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={name || "Product image"}
        loading="lazy"
        draggable={false}
        onError={() => setFailedSrc(src)}
        className={`${size} ${rounded} shrink-0 border border-line bg-card object-cover`}
      />
    );
  }
  return (
    <div
      className={`${size} ${rounded} flex shrink-0 items-center justify-center border border-line bg-surface text-ink-faint`}
      title={src && failedSrc === src ? "This image could not be loaded" : "No image"}
    >
      <Icon name="image" className="h-4 w-4" />
    </div>
  );
}
