import {
  errResponse,
  HttpError,
  parseNonNegativeInt,
  parsePositiveInt,
  parseUnit,
  readJson,
  requireWriter,
} from "@/lib/api";
import {
  addProductToWarehouses,
  type AddProductWarehouseInput,
} from "@/lib/products";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    const user = await requireWriter();
    const { id: rawId } = await ctx.params;
    const productId = Number(rawId);
    if (!Number.isInteger(productId) || productId <= 0) {
      throw new HttpError(400, "Invalid product id.");
    }

    const body = await readJson(req);
    const defaultUnit =
      body.unit !== undefined && body.unit !== null && body.unit !== ""
        ? parseUnit(body.unit)
        : undefined;

    const rawList = Array.isArray(body.warehouses)
      ? body.warehouses
      : Array.isArray(body.warehouseIds)
        ? body.warehouseIds
        : null;

    if (!rawList || rawList.length === 0) {
      throw new HttpError(400, "Select at least one warehouse.");
    }

    const entries: AddProductWarehouseInput[] = rawList.map((item) => {
      if (typeof item === "number" || typeof item === "string") {
        return {
          warehouseId: parsePositiveInt(item, "Warehouse"),
          openingQty: 0,
          unit: defaultUnit,
        };
      }
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new HttpError(400, "Each warehouse entry must be an object.");
      }
      const obj = item as Record<string, unknown>;
      const warehouseId = parsePositiveInt(
        obj.warehouseId ?? obj.id,
        "Warehouse",
      );
      const rawOpening = obj.openingStock ?? obj.openingQty;
      const openingQty =
        rawOpening === undefined || rawOpening === null || rawOpening === ""
          ? 0
          : parseNonNegativeInt(rawOpening, "Opening stock");
      const unit =
        obj.unit !== undefined && obj.unit !== null && obj.unit !== ""
          ? parseUnit(obj.unit)
          : defaultUnit;
      return { warehouseId, openingQty, unit };
    });

    const result = await addProductToWarehouses(productId, entries, user.id);

    return Response.json({
      ok: true,
      productId: result.productId,
      sku: result.sku,
      added: result.added.map((w) => ({
        warehouseId: w.warehouseId,
        warehouseName: w.warehouseName,
        qtyPieces: w.qtyPieces,
        transactionId: w.transaction?.id ?? null,
      })),
      skippedWarehouseIds: result.skippedWarehouseIds,
      resultingTotalPieces: result.resultingTotalPieces,
    });
  } catch (e) {
    return errResponse(e);
  }
}
