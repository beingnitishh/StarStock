"use client";

import { fileExtension, looksLikeImageFile } from "./images";

/**
 * Browser-side image pipeline.
 *
 * Every uploaded product photo goes through this before it touches the
 * network: the file is decoded by the browser (so JPG, PNG, WebP, GIF, BMP,
 * AVIF, ICO, SVG and TIFF all work wherever the browser can render them),
 * large photos are downscaled, and the result is sent as a compact data URL.
 * That keeps the upload well under request-size limits and means the image
 * is stored with the product — it stays visible after editing or reloading.
 */

const MAX_DIMENSION_STEPS = [800, 640, 512, 420, 320];
const QUALITY_STEPS = [0.85, 0.72, 0.6];
const TARGET_DATA_URL_CHARS = 120_000;

export class ImagePrepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImagePrepError";
  }
}

type DecodedImage = {
  width: number;
  height: number;
  draw: (ctx: CanvasRenderingContext2D, width: number, height: number) => void;
  release: () => void;
};

function isHeic(file: File): boolean {
  const type = file.type.toLowerCase();
  const ext = fileExtension(file.name);
  return type.includes("heic") || type.includes("heif") || ext === "heic" || ext === "heif";
}

function unsupportedMessage(file: File): string {
  if (isHeic(file)) {
    return "HEIC/HEIF photos from iPhone cannot be decoded by this browser. On iPhone use Settings → Camera → Formats → “Most Compatible”, or export the photo as JPG, then upload it again.";
  }
  const ext = fileExtension(file.name);
  if (ext === "tif" || ext === "tiff") {
    return "TIFF images are not supported by this browser. Save the image as JPG, PNG or WebP and upload it again.";
  }
  if (!looksLikeImageFile(file)) {
    return "That file is not an image. Choose a JPG, PNG, WebP, GIF, BMP, AVIF, SVG, ICO or TIFF file.";
  }
  return "That image could not be opened — it may be damaged or in an unsupported format. Try JPG, PNG or WebP.";
}

async function decodeWithBitmap(file: File): Promise<DecodedImage | null> {
  if (typeof createImageBitmap !== "function") return null;
  let bitmap: ImageBitmap | null = null;
  try {
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      bitmap = await createImageBitmap(file);
    }
  } catch {
    return null;
  }
  if (!bitmap) return null;
  const bmp = bitmap;
  return {
    width: bmp.width,
    height: bmp.height,
    draw: (ctx, width, height) => ctx.drawImage(bmp, 0, 0, width, height),
    release: () => bmp.close?.(),
  };
}

function decodeWithElement(file: File): Promise<DecodedImage> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.decoding = "sync";
    const cleanup = () => URL.revokeObjectURL(url);
    img.onload = () => {
      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;
      if (!width || !height) {
        cleanup();
        reject(new ImagePrepError(unsupportedMessage(file)));
        return;
      }
      resolve({
        width,
        height,
        draw: (ctx, w, h) => ctx.drawImage(img, 0, 0, w, h),
        release: cleanup,
      });
    };
    img.onerror = () => {
      cleanup();
      reject(new ImagePrepError(unsupportedMessage(file)));
    };
    img.src = url;
  });
}

async function decodeImage(file: File): Promise<DecodedImage> {
  const bitmap = await decodeWithBitmap(file);
  if (bitmap) return bitmap;
  return decodeWithElement(file);
}

function supportsWebp(): boolean {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    return canvas.toDataURL("image/webp").startsWith("data:image/webp");
  } catch {
    return false;
  }
}

function render(
  decoded: DecodedImage,
  maxDimension: number,
  quality: number,
  webp: boolean,
): { dataUrl: string; width: number; height: number } {
  const scale = Math.min(1, maxDimension / Math.max(decoded.width, decoded.height));
  const width = Math.max(1, Math.round(decoded.width * scale));
  const height = Math.max(1, Math.round(decoded.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new ImagePrepError("This browser could not process the image. Try another browser.");
  // White background keeps transparent PNGs looking right in JPEG/WebP.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = "high";
  decoded.draw(ctx, width, height);

  const encoded = webp ? canvas.toDataURL("image/webp", quality) : "";
  const dataUrl = encoded.startsWith("data:image/webp")
    ? encoded
    : canvas.toDataURL("image/jpeg", quality);
  return { dataUrl, width, height };
}

export type PreparedImage = {
  file: File;
  dataUrl: string;
  width: number;
  height: number;
};

/** Decodes, resizes and compresses one image file into a storable data URL. */
export async function prepareProductImage(file: File): Promise<PreparedImage> {
  if (!looksLikeImageFile(file)) {
    throw new ImagePrepError(unsupportedMessage(file));
  }
  let decoded: DecodedImage;
  try {
    decoded = await decodeImage(file);
  } catch (e) {
    throw e instanceof ImagePrepError ? e : new ImagePrepError(unsupportedMessage(file));
  }

  const webp = supportsWebp();
  try {
    let best: { dataUrl: string; width: number; height: number } | null = null;
    outer: for (const dimension of MAX_DIMENSION_STEPS) {
      for (const quality of QUALITY_STEPS) {
        const rendered = render(decoded, dimension, quality, webp);
        best = rendered;
        if (rendered.dataUrl.length <= TARGET_DATA_URL_CHARS) break outer;
      }
    }
    if (!best) throw new ImagePrepError("Could not prepare that image.");
    return { file, dataUrl: best.dataUrl, width: best.width, height: best.height };
  } finally {
    decoded.release();
  }
}

export type PreparedBatch = {
  prepared: PreparedImage[];
  failed: Array<{ file: File; reason: string }>;
};

/** Prepares many images with limited concurrency, reporting progress per file. */
export async function prepareProductImages(
  files: File[],
  onProgress?: (done: number, total: number) => void,
): Promise<PreparedBatch> {
  const prepared: PreparedImage[] = [];
  const failed: Array<{ file: File; reason: string }> = [];
  const total = files.length;
  let done = 0;
  const queue = [...files];
  const concurrency = Math.min(4, Math.max(1, total));

  async function worker() {
    for (;;) {
      const file = queue.shift();
      if (!file) return;
      try {
        prepared.push(await prepareProductImage(file));
      } catch (e) {
        failed.push({
          file,
          reason: e instanceof Error ? e.message : "Could not read that image.",
        });
      } finally {
        done += 1;
        onProgress?.(done, total);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  // Preserve the user's selection order so matching is predictable.
  const order = new Map(files.map((file, index) => [file, index]));
  prepared.sort((a, b) => (order.get(a.file) ?? 0) - (order.get(b.file) ?? 0));
  return { prepared, failed };
}

/** Deduplicates a selection of files (folder pickers often repeat entries). */
export function uniqueImageFiles(files: File[]): File[] {
  const seen = new Set<string>();
  const out: File[] = [];
  for (const file of files) {
    const key = `${file.name}::${file.size}::${file.lastModified}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }
  return out;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
