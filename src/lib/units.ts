export type StockUnit = "piece" | "carton";

/** Convert an entered quantity in the given unit to pieces. */
export function toPieces(qty: number, unit: StockUnit, cartonContains: number): number {
  const per = cartonContains > 0 ? cartonContains : 1;
  return unit === "carton" ? qty * per : qty;
}

/** Split a piece count into whole cartons + loose pieces. */
export function splitCartons(pieces: number, cartonContains: number) {
  const per = cartonContains > 0 ? cartonContains : 1;
  return { cartons: Math.floor(pieces / per), remainder: pieces % per };
}

/** Human readable stock, e.g. "5 CTN + 3 PCS" or "48 pcs". */
export function stockLabel(pieces: number, cartonContains: number): string {
  const { cartons, remainder } = splitCartons(pieces, cartonContains);
  if (cartons === 0) return `${pieces} PCS`;
  if (remainder === 0) return `${cartons} CTN`;
  return `${cartons} CTN + ${remainder} PCS`;
}

export function skuCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

export const nf = new Intl.NumberFormat("en-US");

export function fmtInt(n: number): string {
  return nf.format(n);
}

export function fmtDateTime(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

export function fmtDate(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(d);
}

export function fmtTime(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}
