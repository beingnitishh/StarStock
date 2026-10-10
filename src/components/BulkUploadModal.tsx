"use client";

import { useRef, useState, type DragEvent } from "react";
import { Button, Modal, useToast } from "./ui";
import { Icon } from "./icons";
import type { BulkResult } from "./bulk-types";

export function BulkUploadModal({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkResult | null>(null);

  function reset() {
    setFile(null);
    setError(null);
    setResult(null);
    setBusy(false);
  }

  function close() {
    reset();
    onClose();
  }

  function pickFile(f: File | undefined | null) {
    if (!f) return;
    const lower = f.name.toLowerCase();
    if (!lower.endsWith(".csv") && !lower.endsWith(".xlsx")) {
      setError("Unsupported file type. Upload a .csv or .xlsx file.");
      return;
    }
    setError(null);
    setResult(null);
    setFile(f);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragOver(false);
    pickFile(e.dataTransfer.files?.[0]);
  }

  async function downloadTemplate() {
    const res = await fetch("/api/products/bulk");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "star-stock-bulk-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function submit() {
    if (!file) return;
    setBusy(true);
    setError(null);
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await fetch("/api/products/bulk", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Upload failed.");
      setResult(data as BulkResult);
      if (data.created > 0) {
        toast.push(
          "success",
          `${data.created} product${data.created === 1 ? "" : "s"} listed`,
          data.failed > 0 ? `${data.failed} row(s) were rejected — see the report below.` : undefined,
        );
        onDone();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="Bulk listing"
      subtitle="Upload a CSV or XLSX file with SKU, image link, opening stock, unit and carton size."
      width="max-w-xl"
    >
      <div className="space-y-4">
        <button
          onClick={() => downloadTemplate()}
          className="inline-flex items-center gap-1.5 text-xs font-bold text-brand hover:underline"
        >
          <Icon name="download" className="h-3.5 w-3.5" />
          Download CSV template
        </button>

        {!result ? (
          <>
            <div
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
                dragOver
                  ? "border-brand bg-brand-soft/60"
                  : "border-line-strong bg-card hover:border-brand/50 hover:bg-brand-soft/30"
              }`}
            >
              <span className="rounded-full bg-brand-soft p-2.5 text-brand">
                <Icon name="upload" className="h-5 w-5" />
              </span>
              {file ? (
                <>
                  <p className="font-mono text-sm font-semibold">{file.name}</p>
                  <p className="text-xs text-ink-faint">
                    {(file.size / 1024).toFixed(1)} KB · click “Upload products” to continue
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm font-semibold">Drop your file here or click to browse</p>
                  <p className="text-xs text-ink-faint">.csv or .xlsx · rows are validated before import</p>
                </>
              )}
              <input
                ref={inputRef}
                type="file"
                accept=".csv,.xlsx"
                className="hidden"
                onChange={(e) => {
                  pickFile(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </div>

            {error ? (
              <div className="flex items-start gap-2 rounded-lg border border-out/30 bg-out-soft px-3 py-2.5 text-[13px] font-medium text-out">
                <Icon name="alert" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {error}
              </div>
            ) : null}

            <div className="flex justify-end gap-2 border-t border-line pt-4">
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button variant="primary" onClick={submit} loading={busy} disabled={!file} icon="upload">
                Upload products
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-in/30 bg-in-soft px-4 py-3">
                <p className="font-display text-xl font-bold text-in">{result.created}</p>
                <p className="text-xs font-semibold text-in/80">products listed</p>
              </div>
              <div
                className={`rounded-lg border px-4 py-3 ${
                  result.failed > 0 ? "border-out/30 bg-out-soft" : "border-line bg-card"
                }`}
              >
                <p
                  className={`font-display text-xl font-bold ${result.failed > 0 ? "text-out" : "text-ink-faint"}`}
                >
                  {result.failed}
                </p>
                <p className={`text-xs font-semibold ${result.failed > 0 ? "text-out/80" : "text-ink-faint"}`}>
                  rows rejected
                </p>
              </div>
            </div>

            {result.errors.length > 0 ? (
              <div className="max-h-48 overflow-y-auto rounded-lg border border-line bg-card">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-surface text-[10px] uppercase tracking-wider text-ink-faint">
                    <tr>
                      <th className="px-3 py-2 font-bold">Row</th>
                      <th className="px-3 py-2 font-bold">SKU</th>
                      <th className="px-3 py-2 font-bold">Problem</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {result.errors.map((er, i) => (
                      <tr key={i}>
                        <td className="px-3 py-2 font-mono">{er.row}</td>
                        <td className="px-3 py-2 font-mono font-semibold">{er.sku || "—"}</td>
                        <td className="px-3 py-2 text-ink-soft">{er.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            <div className="flex justify-end gap-2 border-t border-line pt-4">
              {result.created > 0 ? (
                <Button variant="primary" onClick={close}>
                  Done
                </Button>
              ) : (
                <>
                  <Button variant="ghost" onClick={close}>
                    Close
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => {
                      reset();
                    }}
                  >
                    Try another file
                  </Button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
