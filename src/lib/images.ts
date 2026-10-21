/**
 * Image rules shared by the browser and the API.
 *
 * Product images can be one of:
 *   - an http(s) link          (the bulk sheet's "Image URL" column)
 *   - a site-relative path     ("/products/tea.jpg")
 *   - an uploaded image        ("data:image/...;base64,...")
 *
 * Uploaded images are compressed in the browser and then stored in the
 * `product_images` table (see `src/lib/product-images.ts`) so listing
 * hundreds of products never ships megabytes of base64 in the JSON payload.
 */

/** Hard ceiling for a data URL payload (~1.5 MB decoded). */
export const MAX_IMAGE_DATA_URL_CHARS = 2_000_000;

/** Practical ceiling for an external image link. */
export const MAX_IMAGE_LINK_CHARS = 4_000;

/** Every format we can render once the browser has decoded it. */
export const IMAGE_FILE_EXTENSIONS = [
  "jpg",
  "jpeg",
  "jpe",
  "jfif",
  "png",
  "apng",
  "webp",
  "gif",
  "avif",
  "bmp",
  "dib",
  "ico",
  "svg",
  "tif",
  "tiff",
  "heic",
  "heif",
] as const;

/** `accept` attribute used by every file picker in the app. */
export const IMAGE_ACCEPT =
  "image/*,.jpg,.jpeg,.jpe,.jfif,.png,.apng,.webp,.gif,.avif,.bmp,.ico,.svg,.tif,.tiff,.heic,.heif";

const KNOWN_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/pjpeg",
  "image/png",
  "image/apng",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/bmp",
  "image/x-bmp",
  "image/x-ms-bmp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/svg+xml",
  "image/tiff",
  "image/heic",
  "image/heif",
]);

const DATA_IMAGE_RE = /^data:image\/([a-z0-9.+-]+);base64,([\s\S]*)$/i;

export type ParsedImage = {
  /** MIME type detected from the bytes when possible. */
  mimeType: string;
  /** Base64 payload without whitespace. */
  base64: string;
  /** Approximate decoded size in bytes. */
  byteLength: number;
};

export function fileExtension(name: string): string {
  const clean = name.split(/[?#]/)[0];
  const dot = clean.lastIndexOf(".");
  return dot === -1 ? "" : clean.slice(dot + 1).toLowerCase();
}

/** True when the picked file looks like an image, using MIME or extension. */
export function looksLikeImageFile(file: { name: string; type?: string }): boolean {
  const type = (file.type ?? "").toLowerCase();
  if (type.startsWith("image/") || KNOWN_MIME.has(type)) return true;
  const ext = fileExtension(file.name);
  return (IMAGE_FILE_EXTENSIONS as readonly string[]).includes(ext);
}

function normalizeMime(subtype: string): string {
  const s = subtype.toLowerCase();
  if (s === "jpg" || s === "jpeg" || s === "pjpeg") return "image/jpeg";
  if (s === "svg") return "image/svg+xml";
  if (s === "tif") return "image/tiff";
  if (s === "ico") return "image/x-icon";
  return `image/${s}`;
}

function base64ToBytes(base64: string, limit = 32): Uint8Array {
  const slice = base64.slice(0, Math.ceil((limit * 4) / 3));
  const padded = slice.padEnd(Math.ceil(slice.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return new Uint8Array();
  }
}

/** Detects the real image type from magic bytes (more trustworthy than a MIME label). */
export function sniffImageMime(base64: string): string | null {
  const b = base64ToBytes(base64, 32);
  if (b.length < 4) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x42 && b[1] === 0x4d) return "image/bmp";
  if (b[0] === 0x00 && b[1] === 0x00 && (b[2] === 0x01 || b[2] === 0x02) && b[3] === 0x00) {
    return "image/x-icon";
  }
  if (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) return "image/tiff";
  if (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a) return "image/tiff";
  const ascii = Array.from(b.slice(0, 16))
    .map((c) => String.fromCharCode(c))
    .join("");
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return "image/webp";
  if (ascii.slice(4, 8) === "ftyp") {
    const brand = ascii.slice(8, 12);
    if (brand.startsWith("avif") || brand.startsWith("avis")) return "image/avif";
    if (brand.startsWith("heic") || brand.startsWith("heix") || brand.startsWith("hevc") || brand.startsWith("mif1")) {
      return "image/heic";
    }
  }
  // SVG is text; look for an opening tag or XML prolog.
  try {
    const slice = base64.slice(0, 240);
    const text = atob(slice.padEnd(Math.ceil(slice.length / 4) * 4, "=")).trimStart();
    if (text.startsWith("<svg") || (text.startsWith("<?xml") && text.includes("<svg"))) {
      return "image/svg+xml";
    }
  } catch {
    // Not decodable as text — fall through.
  }
  return null;
}

/** Parses and validates a `data:image/*;base64,...` URL. Returns null when invalid/too large. */
export function parseImageDataUrl(value: string): ParsedImage | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_IMAGE_DATA_URL_CHARS) return null;
  const match = DATA_IMAGE_RE.exec(trimmed);
  if (!match) return null;
  const base64 = match[2].replace(/\s+/g, "");
  if (!base64 || base64.length < 8) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const byteLength = Math.floor((base64.length * 3) / 4) - padding;
  if (byteLength <= 0) return null;
  const declared = normalizeMime(match[1]);
  const detected = sniffImageMime(base64);
  const mimeType = detected ?? (KNOWN_MIME.has(declared) ? declared : null);
  if (!mimeType) return null;
  return { mimeType, base64, byteLength };
}

export function isStoredImageUrl(value: string): boolean {
  return /^\/api\/products\/\d+\/image(\?|$)/.test(value);
}

export type ImageUrlCheck =
  | { ok: true; value: string }
  | { ok: false; error: string };

/**
 * Validates an image value coming from a form, a sheet row or the API.
 * Never silently truncates — callers must surface the error instead.
 */
export function checkImageUrl(raw: unknown, { allowEmpty = true }: { allowEmpty?: boolean } = {}): ImageUrlCheck {
  const value = String(raw ?? "").trim();
  if (!value) {
    return allowEmpty
      ? { ok: true, value: "" }
      : { ok: false, error: "An image is required." };
  }
  if (/^data:/i.test(value)) {
    if (!/^data:image\//i.test(value)) {
      return { ok: false, error: "Only image uploads are supported for product photos." };
    }
    if (value.length > MAX_IMAGE_DATA_URL_CHARS) {
      return {
        ok: false,
        error: "That image is too large. Use an image under 1.5 MB (photos are resized automatically when uploaded from this screen).",
      };
    }
    if (!parseImageDataUrl(value)) {
      return {
        ok: false,
        error: "That image could not be read. Re-upload the file — it may be corrupted or in a format the browser cannot convert.",
      };
    }
    return { ok: true, value };
  }
  if (/^https?:\/\//i.test(value)) {
    if (value.length > MAX_IMAGE_LINK_CHARS) {
      return { ok: false, error: "The image link is too long." };
    }
    return { ok: true, value };
  }
  if (value.startsWith("/") && !value.startsWith("//")) {
    return { ok: true, value };
  }
  if (/^blob:/i.test(value)) {
    return {
      ok: false,
      error: "The browser preview of this file cannot be saved. Re-upload the image so it is stored with the product.",
    };
  }
  return {
    ok: false,
    error: "Image must be a link starting with http:// or https://, or an image uploaded from your device.",
  };
}

/**
 * True for a plain file name such as `BTL-750.jpg` — used in sheets where the
 * user typed the photo file instead of a link. Those rows still import and the
 * photo can be attached from the bulk upload screen.
 */
export function isBareImageFileName(value: string): boolean {
  const v = value.trim();
  if (!v || /[/\\]/.test(v) || /^[a-z]+:/i.test(v)) return false;
  return (IMAGE_FILE_EXTENSIONS as readonly string[]).includes(fileExtension(v));
}

/** Turns an image file name into a matching key (SKU candidates). */
export function imageKeyCandidates(fileName: string): string[] {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const withoutExt = base.replace(/\.[^.]+$/, "");
  let decoded = withoutExt;
  try {
    decoded = decodeURIComponent(withoutExt);
  } catch {
    // keep raw name
  }
  // Only strip explicit "copy" markers. Numbers are kept because "IMG-1" may
  // be the real SKU — silently attaching a photo to the wrong product is
  // worse than asking the user to rename the file.
  const cleaned = decoded
    .replace(/\s*\((?:copy|kopie)\)$/i, "")
    .replace(/[-_ ]copy$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const keys = new Set<string>();
  for (const candidate of [decoded, cleaned]) {
    const v = candidate.trim();
    if (!v) continue;
    keys.add(v.toLowerCase());
    // "BTL 750" and "BTL-750" should match the same SKU as long as there is no clash.
    keys.add(v.toLowerCase().replace(/[^a-z0-9]+/g, ""));
    keys.add(v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
  }
  return Array.from(keys).filter(Boolean);
}
