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
    if (f.size > 10 * 1024 * 1024) {
      setError("File too large. Max 10 MB — split into smaller sheets.");
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
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast.push("error", "Could not download template", data.error as string | undefined);
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const cd = res.headers.get("content-disposition") || "";
    const match = cd.match(/filename="?([^"]+)"?/);
    a.download = match?.[1] ?? "star-stock-bulk-template.xlsx";
    const ct = res.headers.get("content-type") || "";
    if (!match && ct.includes("text/csv")) a.download = "star-stock-bulk-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadErrorsCsv() {
    if (!result?.errors?.length) return;
    const header = "Row,SKU,Problem\n";
    const rows = result.errors
      .map((er) => {
        const sku = `"${(er.sku || "").replace(/"/g, '""')}"`;
        const msg = `"${er.message.replace(/"/g, '""')}"`;
        return `${er.row},${sku},${msg}`;
      })
      .join("\n");
    const full = header + rows;
    if (result.hasMoreErrors) {
      // add note
    }
    const blob = new Blob([full], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `bulk-errors-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.push("success", "Error report downloaded", `${result.errors.length} rows in CSV (full log saved in Supabase).`);
  }

  function copyErrors() {
    if (!result?.errors?.length) return;
    const text = result.errors.map((er) => `Row ${er.row} [${er.sku || "—"}]: ${er.message}`).join("\n");
    navigator.clipboard.writeText(text).then(
      () => toast.push("success", "Copied", `${result.errors.length} errors copied to clipboard.`),
      () => toast.push("error", "Copy failed", "Please download the CSV instead."),
    );
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
          data.failed > 0 ? `${data.failed} row(s) were rejected — see the report below. Full details saved in Supabase.` : undefined,
        );
        onDone();
      } else if (data.failed > 0) {
        toast.push("error", "No products listed", `${data.failed} rows rejected — check the report below.`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="Bulk listing"
      subtitle="Upload a CSV or XLSX file with SKU, image link, opening stock, unit, carton size and warehouse. Use the Excel template for dropdowns."
      width="max-w-2xl"
    >
      <div className="space-y-4">
        <button
          onClick={() => downloadTemplate()}
          className="inline-flex items-center gap-1.5 text-xs font-bold text-brand hover:underline"
        >
          <Icon name="download" className="h-3.5 w-3.5" />
          Download Excel template
        </button>
        <p className="text-[11px] leading-relaxed text-ink-faint">
          The <span className="font-semibold">Warehouse</span> column has a dropdown of your warehouses plus{" "}
          <span className="font-semibold text-brand">All Warehouses</span>. Choose a single warehouse or All Warehouses to list the product in every warehouse at once.
          <br />
          <span className="text-ink-soft">Large files (600+ rows) are processed in batches — progress is tracked in Supabase for later review.</span>
        </p>

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
                    {(file.size / 1024).toFixed(1)} KB · {file.name.toLowerCase().endsWith(".csv") ? "CSV" : "Excel"} · click “Upload products” to continue
                  </p>
                  {file.size > 2 * 1024 * 1024 ? (
                    <p className="text-[11px] font-medium text-amber-600">Large file — will be processed in batches (≈600 rows in ~10–20s).</p>
                  ) : null}
                </>
              ) : (
                <>
                  <p className="text-sm font-semibold">Drop your file here or click to browse</p>
                  <p className="text-xs text-ink-faint">.csv or .xlsx · rows are validated before import · max 2000 rows</p>
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
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
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
              <div className="rounded-lg border border-line bg-card px-4 py-3">
                <p className="font-display text-xl font-bold text-ink">{result.totalRows ?? result.created + result.failed}</p>
                <p className="text-xs font-semibold text-ink-faint">total rows in file</p>
              </div>
            </div>

            {result.summary && result.summary.length > 0 ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
                <p className="text-xs font-bold uppercase tracking-wide text-amber-700">Why rows failed — grouped</p>
                <ul className="mt-2 space-y-1">
                  {result.summary.map((s, i) => (
                    <li key={i} className="flex justify-between gap-2 text-xs">
                      <span className="text-ink-soft">{s.message}</span>
                      <span className="font-mono font-bold text-amber-700">{s.count}×</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[11px] text-ink-faint">
                  Tip: Most common for 600-row sheets is <span className="font-semibold">duplicate SKU</span> or <span className="font-semibold">unknown warehouse name</span> (typo vs dropdown). Fix those rows and re-upload only the failed ones.
                </p>
              </div>
            ) : null}

            {result.historyId ? (
              <div className="flex items-center gap-2 rounded-lg border border-brand/20 bg-brand-soft/40 px-3 py-2.5 text-xs">
                <Icon name="check" className="h-4 w-4 text-brand" />
                <span className="font-semibold text-ink">
                  Logged to Supabase <span className="font-mono text-brand">bulk_uploads #{result.historyId}</span>
                </span>
                <span className="text-ink-faint">— full error JSON saved, even if you close this dialog.</span>
              </div>
            ) : null}

            {result.errors.length > 0 ? (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-bold text-ink">
                    Rejected rows {result.hasMoreErrors ? `(showing ${result.errors.length} of ${result.totalErrors})` : `(${result.errors.length})`}
                  </p>
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="secondary" icon="download" onClick={downloadErrorsCsv}>
                      Download CSV
                    </Button>
                    <Button size="sm" variant="ghost" onClick={copyErrors}>
                      Copy
                    </Button>
                  </div>
                </div>
                <div className="max-h-64 overflow-y-auto rounded-lg border border-line bg-card">
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
                        <tr key={i} className="hover:bg-surface/60">
                          <td className="px-3 py-2 font-mono">{er.row}</td>
                          <td className="px-3 py-2 font-mono font-semibold">{er.sku || "—"}</td>
                          <td className="px-3 py-2 text-ink-soft">{er.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {result.hasMoreErrors ? (
                  <p className="text-[11px] text-ink-faint">
                    Showing first 200 errors. Full list ({result.totalErrors} rows) is stored in Supabase `bulk_uploads` table (id {result.historyId}) — query it to export all.
                  </p>
                ) : null}
                <p className="text-[11px] text-ink-faint">
                  Fix the highlighted issues in your sheet and re-upload only those rows. Duplicate SKUs already in the catalog must be removed or renamed.
                </p>
              </div>
            ) : (
              <div className="rounded-lg border border-in/20 bg-in-soft px-4 py-3 text-sm font-semibold text-in">
                All rows imported successfully — no errors to review.
              </div>
            )}

            <div className="flex justify-end gap-2 border-t border-line pt-4">
              {result.failed > 0 ? (
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
              ) : (
                <Button variant="primary" onClick={close}>
                  Done
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
