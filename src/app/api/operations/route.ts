import {
  errResponse,
  HttpError,
  parseNonNegativeInt,
  parsePositiveInt,
  parseUnit,
  readJson,
  requireUser,
} from "@/lib/api";
import { performOperation, type OpType } from "@/lib/stock";

const TYPES = new Set<OpType>(["inbound", "outbound", "transfer", "adjustment"]);

export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const body = await readJson(req);

    const type = String(body.type ?? "") as OpType;
    if (!TYPES.has(type)) {
      throw new HttpError(400, "Unknown operation type.");
    }
    const productId = parsePositiveInt(body.productId, "Product");
    const unit = parseUnit(body.unit);
    const qty =
      type === "adjustment"
        ? parseNonNegativeInt(body.qty, "Final stock quantity")
        : parsePositiveInt(body.qty, "Quantity");

    const parseOptId = (value: unknown, field: string): number | null => {
      if (value === null || value === undefined || value === "") return null;
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) {
        throw new HttpError(400, `${field} is invalid.`);
      }
      return n;
    };

    const warehouseId = parseOptId(body.warehouseId, "Warehouse");
    const toWarehouseId = parseOptId(body.toWarehouseId, "Destination warehouse");
    const destination = body.destination
      ? String(body.destination).trim().slice(0, 120)
      : null;
    const reason = body.reason ? String(body.reason).trim().slice(0, 500) : null;

    const result = await performOperation({
      type,
      productId,
      qty,
      unit,
      warehouseId,
      toWarehouseId,
      destination,
      reason,
      userId: user.id,
    });

    return Response.json({ ok: true, ...result });
  } catch (e) {
    return errResponse(e);
  }
}
