import { errResponse, HttpError, requireUser } from "@/lib/api";
import { fetchTransactionRows, type TxFilters } from "@/lib/query";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    await requireUser();
    const url = new URL(req.url);
    const filters: TxFilters = {};

    const q = url.searchParams.get("q");
    if (q) filters.q = q;

    const type = url.searchParams.get("type");
    if (type) {
      if (!["inbound", "outbound", "transfer", "adjustment"].includes(type)) {
        throw new HttpError(400, "Invalid type filter.");
      }
      filters.type = type;
    }

    const warehouseId = url.searchParams.get("warehouseId");
    if (warehouseId) filters.warehouseId = Number(warehouseId);

    const productId = url.searchParams.get("productId");
    if (productId) filters.productId = Number(productId);

    const from = url.searchParams.get("from");
    if (from) {
      const d = new Date(from);
      if (Number.isNaN(d.getTime())) throw new HttpError(400, "Invalid from date.");
      filters.from = d;
    }
    const to = url.searchParams.get("to");
    if (to) {
      const d = new Date(to);
      if (Number.isNaN(d.getTime())) throw new HttpError(400, "Invalid to date.");
      // include the whole day
      d.setHours(23, 59, 59, 999);
      filters.to = d;
    }

    const limit = url.searchParams.get("limit");
    if (limit !== null && limit !== "") {
      const n = Number(limit);
      if (!Number.isFinite(n) || n < 1) {
        throw new HttpError(400, "limit must be a number of at least 1.");
      }
      filters.limit = Math.floor(n);
    }

    const rows = await fetchTransactionRows(filters);
    return Response.json({ transactions: rows });
  } catch (e) {
    return errResponse(e);
  }
}
