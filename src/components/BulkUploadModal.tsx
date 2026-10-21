"use client";

import { useRef, useState, type DragEvent } from "react";
import { Button, Modal, Spinner, useToast } from "./ui";
import { Icon } from "./icons";
import type { BulkImageReport, BulkResult } from "./bulk-types";
import { IMAGE_ACCEPT, imageKeyCandidates, looksLikeImageFile } from "@/lib/images";
import { formatBytes, prepareProductImages, uniqueImageFiles, type PreparedImage } from "@/lib/image-client";

type Phase = { kind: "prepare" | "import" | "attach"; done: number; total: number };

type ImageItem = { sku: string; fileName: string; imageUrl: string };

function chunkImageItems(items: ImageItem[]): ImageItem[][] {
  const batches: ImageItem[][] = [];
  let current: ImageItem[] = [];
  let chars = 0;
  for (const item of items) {
    const tooMany = current.length >= 25;
    const tooBig = chars + item.imageUrl.length > 1_200_000;
    if (current.length > 0 && (tooMany || tooBig)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += item.imageUrl.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Maps image files to SKUs. The file name is the key (`BTL-750.jpg` →
 * SKU `BTL-750`), and `row-4.jpg` can be used when the sheet row number is
 * easier. Images for rows that already carry a link in the sheet still win:
 * an explicitly attached photo is the clearer intent.
 */
function planImageUploads(
  prepared: PreparedImage[],
  createdItems: Array<{ row: number; sku: string }>,
): { items: ImageItem[]; issues: BulkImageReport["errors"] } {
  const byKey = new Map<string, string>();
  const byRow = new Map<number, string>();
  for (const created of createdItems) {
    byRow.set(created.row, created.sku);
    for (const key of imageKeyCandidates(created.sku)) {
      if (!byKey.has(key)) byKey.set(key, created.sku);
    }
  }

  const assigned = new Set<string>();
  const items: ImageItem[] = [];
  const issues: BulkImageReport["errors"] = [];

  for (const image of prepared) {
    const keys = imageKeyCandidates(image.file.name);
    let sku: string | null = null;

    for (const key of keys) {
      const match = byKey.get(key);
      if (match) {
        sku = match;
        break;
      }
    }

    if (!sku) {
      const rowMatch = /(?:^|[\\/])(?:row|r)[-_ ]?(\d{1,5})$/.exec(
        image.file.name.replace(/\.[^.]+$/, ""),
      );
      if (rowMatch) {
        const row = Number(rowMatch[1]);
        const fromRow = byRow.get(row);
        if (fromRow) sku = fromRow;
        else {
          issues.push({
            sku: "",
            fileName: image.file.name,
            message: `No imported product on row ${row}. Name the image after the SKU instead (e.g. BTL-750.jpg).`,
          });
          continue;
        }
      }
    }

    if (!sku) {
      // Might still be a product listed earlier — the server resolves any SKU.
      sku = keys[0] ?? "";
    }
    if (!sku) {
      issues.push({ sku: "", fileName: image.file.name, message: "Could not read a SKU from this file name." });
      continue;
    }

    const key = sku.toLowerCase();
    if (assigned.has(key)) {
      issues.push({
        sku,
        fileName: image.file.name,
        message: `Another image was already matched to ${sku}. Only one photo per product is stored.`,
      });
      continue;
    }
    assigned.add(key);
    items.push({ sku, fileName: image.file.name, imageUrl: image.dataUrl });
  }

  return { items, issues };
}

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
  const imageInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const [skippedFiles, setSkippedFiles] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkResult | null>(null);

  function reset() {
    setFile(null);
    setImageFiles([]);
    setSkippedFiles(0);
    setError(null);
    setResult(null);
    setBusy(false);
    setPhase(null);
  }

  function close() {
    if (busy) return;
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

  function pickImages(list: FileList | File[] | null) {
    if (!list) return;
    const incoming = Array.from(list);
    if (incoming.length === 0) return;
    // Folder pickers return every file in the folder — keep only images.
    const images = incoming.filter(looksLikeImageFile);
    const skipped = incoming.length - images.length;
    setSkippedFiles((current) => current + skipped);
    if (images.length === 0) {
      setError(
        "No image files were found in that selection. Choose JPG, PNG, WebP, GIF, BMP, AVIF, SVG or TIFF files (each named after its SKU).",
      );
      return;
    }
    setError(null);
    setResult(null);
    setImageFiles((current) => uniqueImageFiles([...current, ...images]));
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const dropped = e.dataTransfer.files;
    if (!dropped || dropped.length === 0) return;
    const sheet = Array.from(dropped).find((f) => /\.(csv|xlsx)$/i.test(f.name));
    const images = Array.from(dropped).filter((f) => !/\.(csv|xlsx)$/i.test(f.name));
    if (sheet) pickFile(sheet);
    if (images.length > 0) pickImages(images);
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
    if (!result) return;
    const rows: string[] = ["Row,SKU,Problem"];
    for (const er of result.errors ?? []) {
      const sku = `"${(er.sku || "").replace(/"/g, '""')}"`;
      const msg = `"${er.message.replace(/"/g, '""')}"`;
      rows.push(`${er.row},${sku},${msg}`);
    }
    for (const er of result.images?.errors ?? []) {
      rows.push(
        `,"${(er.sku || "").replace(/"/g, '""')}","${`${er.fileName ? `${er.fileName}: ` : ""}${er.message}`.replace(/"/g, '""')}"`,
      );
    }
    if (rows.length === 1) return;
    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `bulk-errors-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function copyErrors() {
    if (!result) return;
    const lines: string[] = [];
    for (const er of result.errors ?? []) lines.push(`Row ${er.row} [${er.sku || "—"}]: ${er.message}`);
    for (const er of result.images?.errors ?? []) {
      lines.push(`Image ${er.fileName || "—"} [${er.sku || "—"}]: ${er.message}`);
    }
    if (lines.length === 0) return;
    navigator.clipboard.writeText(lines.join("\n")).then(
      () => toast.push("success", "Copied", `${lines.length} issue(s) copied to clipboard.`),
      () => toast.push("error", "Copy failed", "Please download the CSV instead."),
    );
  }

  async function uploadImages(items: ImageItem[], issues: BulkImageReport["errors"]): Promise<BulkImageReport> {
    const batches = chunkImageItems(items);
    const report: BulkImageReport = { attached: 0, failed: 0, errors: [...issues], total: items.length + issues.length };
    let done = 0;
    for (const batch of batches) {
      setPhase({ kind: "attach", done, total: items.length });
      try {
        const res = await fetch("/api/products/images", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ items: batch }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((data.error as string) || "Image upload failed.");
        report.attached += Number(data.updated ?? 0);
        for (const err of (data.errors ?? []) as BulkImageReport["errors"]) {
          report.errors.push(err);
        }
      } catch (e) {
        for (const item of batch) {
          report.errors.push({
            sku: item.sku,
            fileName: item.fileName,
            message: e instanceof Error ? e.message : "Could not upload this image.",
          });
        }
      }
      done += batch.length;
      setPhase({ kind: "attach", done, total: items.length });
    }
    report.failed = report.errors.length;
    return report;
  }

  async function submit() {
    if (!file && imageFiles.length === 0) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      let prepared: PreparedImage[] = [];
      const imageErrors: BulkImageReport["errors"] = [];

      if (imageFiles.length > 0) {
        setPhase({ kind: "prepare", done: 0, total: imageFiles.length });
        const preparedBatch = await prepareProductImages(imageFiles, (done, total) =>
          setPhase({ kind: "prepare", done, total }),
        );
        prepared = preparedBatch.prepared;
        for (const failure of preparedBatch.failed) {
          imageErrors.push({ sku: "", fileName: failure.file.name, message: failure.reason });
        }
      }

      let imported: BulkResult | null = null;
      if (file) {
        setPhase({ kind: "import", done: 0, total: 1 });
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/products/bulk", { method: "POST", body: fd });
        const data = (await res.json()) as BulkResult & { error?: string };
        if (!res.ok) throw new Error(data.error ?? "Upload failed.");
        imported = data;
        setPhase({ kind: "import", done: 1, total: 1 });
      }

      let images: BulkImageReport | undefined;
      if (prepared.length > 0 || imageErrors.length > 0) {
        const plan = planImageUploads(prepared, imported?.createdItems ?? []);
        images = await uploadImages(plan.items, [...imageErrors, ...plan.issues]);
      }

      const merged: BulkResult = {
        created: imported?.created ?? 0,
        failed: imported?.failed ?? 0,
        errors: imported?.errors ?? [],
        hasMoreErrors: imported?.hasMoreErrors,
        totalErrors: imported?.totalErrors,
        summary: imported?.summary,
        historyId: imported?.historyId ?? null,
        totalRows: imported?.totalRows ?? 0,
        createdItems: imported?.createdItems,
        images,
      };
      setResult(merged);

      const attached = images?.attached ?? 0;
      if (merged.created > 0 || attached > 0) {
        const parts: string[] = [];
        if (merged.created > 0) parts.push(`${merged.created} product${merged.created === 1 ? "" : "s"} listed`);
        if (attached > 0) parts.push(`${attached} photo${attached === 1 ? "" : "s"} attached`);
        toast.push("success", parts.join(" · "), merged.failed > 0 || images?.failed ? "Some rows or images need attention — see the report." : undefined);
        onDone();
      } else if (merged.failed > 0 || (images?.failed ?? 0) > 0) {
        toast.push("error", "Nothing was saved", "Check the report below and try again.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusy(false);
      setPhase(null);
    }
  }

  const imageTotalBytes = imageFiles.reduce((sum, f) => sum + f.size, 0);
  const canSubmit = Boolean(file) || imageFiles.length > 0;
  const busyLabel =
    phase?.kind === "prepare"
      ? `Optimising images ${phase.done}/${phase.total}`
      : phase?.kind === "import"
        ? "Importing products…"
        : phase?.kind === "attach"
          ? `Attaching photos ${phase.done}/${phase.total}`
          : "Working…";

  const issueCount =
    (result?.errors?.length ?? 0) + (result?.images?.errors.length ?? 0);

  return (
    <Modal
      open={open}
      onClose={close}
      title="Bulk listing"
      subtitle="Upload a CSV or XLSX file with SKU, image link, opening stock, unit, carton size and warehouse. Photos can be added in the same step — with or without a sheet."
      width="max-w-2xl"
    >
      <div className="space-y-4">
        {!result ? (
          <>
            <button
              onClick={() => downloadTemplate()}
              className="inline-flex items-center gap-1.5 text-xs font-bold text-brand hover:underline"
            >
              <Icon name="download" className="h-3.5 w-3.5" />
              Download Excel template
            </button>

            {/* Sheet */}
            <div
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors ${
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
                    {(file.size / 1024).toFixed(1)} KB · {file.name.toLowerCase().endsWith(".csv") ? "CSV" : "Excel"} · click “Upload” to continue
                  </p>
                  {file.size > 2 * 1024 * 1024 ? (
                    <p className="text-[11px] font-medium text-amber-600">Large file — will be processed in batches (≈600 rows in ~10–20s).</p>
                  ) : null}
                </>
              ) : (
                <>
                  <p className="text-sm font-semibold">Drop your sheet here or click to browse</p>
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

            <p className="text-[11px] leading-relaxed text-ink-faint">
              The <span className="font-semibold">Warehouse</span> column has a dropdown of your warehouses plus{" "}
              <span className="font-semibold text-brand">All Warehouses</span>. Choose a single warehouse or All Warehouses to list the product in every warehouse at once.
              <br />
              <span className="text-ink-soft">Large files (600+ rows) are processed in batches — progress is tracked in Supabase for later review.</span>
            </p>

            {/* Images */}
            <div className="rounded-xl border border-line bg-surface/60 p-3.5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="flex items-center gap-1.5 text-xs font-bold text-ink">
                    <Icon name="image" className="h-3.5 w-3.5 text-brand" />
                    Product photos
                    <span className="rounded-full bg-brand-soft px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-brand">optional</span>
                  </p>
                  <p className="mt-1 max-w-md text-[11px] leading-relaxed text-ink-faint">
                    Name each photo after its SKU — <span className="font-mono text-ink-soft">BTL-750.jpg</span> goes to SKU{" "}
                    <span className="font-mono text-ink-soft">BTL-750</span>. Select many files or a whole folder. Use this even
                    when the sheet has no Image URL: photos are resized automatically and attached to each product.
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Button
                    size="sm"
                    variant="secondary"
                    icon="upload"
                    disabled={busy}
                    onClick={() => imageInputRef.current?.click()}
                  >
                    Choose images
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => folderInputRef.current?.click()}
                  >
                    Choose folder
                  </Button>
                </div>
              </div>

              <input
                ref={imageInputRef}
                type="file"
                accept={IMAGE_ACCEPT}
                multiple
                className="hidden"
                onChange={(e) => {
                  pickImages(e.target.files);
                  e.target.value = "";
                }}
              />
              <input
                ref={folderInputRef}
                type="file"
                accept={IMAGE_ACCEPT}
                multiple
                // Folder selection is not in the React types yet.
                {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
                className="hidden"
                onChange={(e) => {
                  pickImages(e.target.files);
                  e.target.value = "";
                }}
              />

              {imageFiles.length > 0 ? (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-card px-3 py-2">
                  <p className="text-[11px] font-semibold text-ink">
                    {imageFiles.length} image{imageFiles.length === 1 ? "" : "s"} selected{" "}
                    <span className="font-normal text-ink-faint">
                      · {formatBytes(imageTotalBytes)} · compressed before upload
                      {skippedFiles > 0 ? ` · ${skippedFiles} other file${skippedFiles === 1 ? "" : "s"} skipped` : ""}
                    </span>
                  </p>
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => {
                        setImageFiles([]);
                        setSkippedFiles(0);
                      }}
                      className="text-[11px] font-semibold text-out hover:underline"
                    >
                      Clear
                    </button>
                    <span className="max-w-[260px] truncate font-mono text-[10px] text-ink-faint">
                      {imageFiles.slice(0, 3).map((f) => f.name).join(", ")}
                      {imageFiles.length > 3 ? ` +${imageFiles.length - 3} more` : ""}
                    </span>
                  </div>
                </div>
              ) : (
                <p className="mt-2 text-[11px] text-ink-faint">
                  No photos selected — products will be listed without an image and you can add photos later.
                </p>
              )}
            </div>

            {error ? (
              <div className="flex items-start gap-2 rounded-lg border border-out/30 bg-out-soft px-3 py-2.5 text-[13px] font-medium text-out">
                <Icon name="alert" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {error}
              </div>
            ) : null}

            <div className="flex items-center justify-end gap-2 border-t border-line pt-4">
              {busy ? (
                <span className="mr-auto flex items-center gap-2 text-xs font-semibold text-ink-soft">
                  <Spinner className="h-3.5 w-3.5" />
                  {busyLabel}
                </span>
              ) : !file && imageFiles.length > 0 ? (
                <span className="mr-auto text-[11px] text-ink-faint">
                  No sheet selected — photos will be attached to existing products by SKU.
                </span>
              ) : null}
              <Button variant="ghost" onClick={close} disabled={busy}>
                Cancel
              </Button>
              <Button variant="primary" onClick={submit} loading={busy} disabled={!canSubmit} icon="upload">
                {file ? "Upload products" : "Attach photos"}
              </Button>
            </div>
          </>
        ) : (
          <>
            {(result.totalRows ?? 0) > 0 ? (
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
                <p className={`font-display text-xl font-bold ${result.failed > 0 ? "text-out" : "text-ink-faint"}`}>
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
            ) : null}

            {result.images ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-brand/25 bg-brand-soft/40 px-4 py-3">
                  <p className="font-display text-xl font-bold text-brand">{result.images.attached}</p>
                  <p className="text-xs font-semibold text-brand/80">photos attached &amp; live</p>
                </div>
                <div
                  className={`rounded-lg border px-4 py-3 ${
                    result.images.errors.length > 0 ? "border-amber-200 bg-amber-50" : "border-line bg-card"
                  }`}
                >
                  <p className={`font-display text-xl font-bold ${result.images.errors.length > 0 ? "text-amber-700" : "text-ink-faint"}`}>
                    {result.images.errors.length}
                  </p>
                  <p className={`text-xs font-semibold ${result.images.errors.length > 0 ? "text-amber-700/80" : "text-ink-faint"}`}>
                    photos skipped
                  </p>
                </div>
              </div>
            ) : null}

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

            {issueCount > 0 ? (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-bold text-ink">
                    Issues {result.hasMoreErrors ? `(showing ${issueCount} of ${(result.totalErrors ?? 0) + (result.images?.errors.length ?? 0)})` : `(${issueCount})`}
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
                        <th className="px-3 py-2 font-bold">Row / File</th>
                        <th className="px-3 py-2 font-bold">SKU</th>
                        <th className="px-3 py-2 font-bold">Problem</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {(result.errors ?? []).map((er, i) => (
                        <tr key={`row-${i}`} className="hover:bg-surface/60">
                          <td className="px-3 py-2 font-mono">{er.row}</td>
                          <td className="px-3 py-2 font-mono font-semibold">{er.sku || "—"}</td>
                          <td className="px-3 py-2 text-ink-soft">{er.message}</td>
                        </tr>
                      ))}
                      {(result.images?.errors ?? []).map((er, i) => (
                        <tr key={`img-${i}`} className="hover:bg-surface/60">
                          <td className="max-w-[180px] truncate px-3 py-2 font-mono" title={er.fileName}>
                            {er.fileName || "image"}
                          </td>
                          <td className="px-3 py-2 font-mono font-semibold">{er.sku || "—"}</td>
                          <td className="px-3 py-2 text-ink-soft">{er.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {result.hasMoreErrors ? (
                  <p className="text-[11px] text-ink-faint">
                    Showing first 200 row errors. Full list ({result.totalErrors} rows) is stored in Supabase `bulk_uploads` table (id {result.historyId}) — query it to export all.
                  </p>
                ) : null}
                <p className="text-[11px] text-ink-faint">
                  Fix the highlighted issues and re-upload only those rows or photos. Duplicate SKUs already in the catalog must be removed or renamed.
                </p>
              </div>
            ) : (
              <div className="rounded-lg border border-in/20 bg-in-soft px-4 py-3 text-sm font-semibold text-in">
                {(result.totalRows ?? 0) > 0
                  ? "All rows imported successfully — no errors to review."
                  : "All photos attached successfully — they are live on their products."}
              </div>
            )}

            <div className="flex justify-end gap-2 border-t border-line pt-4">
              {issueCount > 0 ? (
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
