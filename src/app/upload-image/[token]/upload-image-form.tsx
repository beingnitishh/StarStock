"use client";

import { useState, type ChangeEvent, type FormEvent } from "react";
import { Button, Field, ProductThumb, Spinner } from "@/components/ui";
import { Icon } from "@/components/icons";
import { IMAGE_ACCEPT } from "@/lib/images";
import { prepareProductImage } from "@/lib/image-client";

export function UploadImageForm({
  token,
  sku,
}: {
  token: string;
  sku: string;
}) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setPreparing(true);
    setImageUrl(null);
    setFileName("");
    setError(null);
    try {
      const prepared = await prepareProductImage(file);
      setImageUrl(prepared.dataUrl);
      setFileName(file.name);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read that image. Try a different file.");
    } finally {
      setPreparing(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!imageUrl || saving || saved) return;

    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/upload-image/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ imageUrl }),
      });
      const result = (await response.json()) as { error?: string; message?: string };
      if (!response.ok) throw new Error(result.error ?? "The image could not be saved. Please try again.");
      setSaved(true);
      setImageUrl(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The image could not be saved. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  if (saved) {
    return (
      <div role="status" className="flex items-center gap-2 rounded-lg border border-in/25 bg-in/5 px-4 py-3 text-sm font-semibold text-in">
        <Icon name="check-circle" className="h-5 w-5 shrink-0" />
        Image saved
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Choose an image" required hint="one photo">
        <input
          type="file"
          accept={IMAGE_ACCEPT}
          onChange={onFileChange}
          disabled={preparing || saving}
          className="block w-full rounded-lg border border-line-strong bg-card px-3 py-2 text-sm text-ink file:mr-3 file:rounded-md file:border-0 file:bg-brand-soft file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-brand disabled:opacity-50"
        />
      </Field>

      {preparing ? (
        <p className="flex items-center gap-2 text-xs text-ink-faint">
          <Spinner className="h-3.5 w-3.5" /> Preparing and compressing image…
        </p>
      ) : imageUrl ? (
        <div className="flex items-center gap-3 rounded-lg border border-line bg-surface p-3">
          <ProductThumb src={imageUrl} name={sku} size="h-14 w-14" rounded="rounded-lg" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink">{fileName}</p>
            <p className="mt-0.5 text-xs text-ink-faint">Ready to upload</p>
          </div>
        </div>
      ) : (
        <p className="text-xs leading-relaxed text-ink-faint">
          JPG, PNG, WebP, GIF, BMP, AVIF, SVG or TIFF. The image is resized and compressed before saving.
        </p>
      )}

      {error ? (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-out/30 bg-out-soft px-3 py-2.5 text-[13px] font-medium text-out">
          <Icon name="alert" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      ) : null}

      <Button type="submit" variant="primary" loading={saving} disabled={!imageUrl || preparing} className="w-full">
        Save image
      </Button>
    </form>
  );
}
