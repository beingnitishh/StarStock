import { asc, eq } from "drizzle-orm";
import ExcelJS from "exceljs";
import { db } from "@/db";
import { products, warehouseStock, warehouses } from "@/db/schema";
import { errResponse, requireUser } from "@/lib/api";
import { skuCompare, splitCartons } from "@/lib/units";

export const dynamic = "force-dynamic";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "warehouse";
}

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  try {
    await requireUser();
    const { id: rawId } = await ctx.params;
    const id = Number(rawId);
    if (!Number.isInteger(id)) {
      return Response.json({ error: "Invalid warehouse id." }, { status: 400 });
    }

    const [warehouseRow] = await db
      .select()
      .from(warehouses)
      .where(eq(warehouses.id, id))
      .limit(1);
    if (!warehouseRow) {
      return Response.json({ error: "Warehouse not found." }, { status: 404 });
    }

    const [prods, stockRows] = await Promise.all([
      db.select().from(products).orderBy(asc(products.id)),
      db
        .select({
          productId: warehouseStock.productId,
          qtyPieces: warehouseStock.qtyPieces,
          updatedAt: warehouseStock.updatedAt,
        })
        .from(warehouseStock)
        .where(eq(warehouseStock.warehouseId, id)),
    ]);

    const stockMap = new Map<number, { qtyPieces: number; updatedAt: Date | null }>();
    for (const s of stockRows) {
      stockMap.set(s.productId, { qtyPieces: s.qtyPieces, updatedAt: s.updatedAt });
    }

    const items = prods
      .map((p) => {
        const s = stockMap.get(p.id) ?? { qtyPieces: 0, updatedAt: null };
        return { product: p, qtyPieces: s.qtyPieces, updatedAt: s.updatedAt };
      })
      .filter((i) => i.qtyPieces > 0)
      .sort((a, b) => skuCompare(a.product.sku, b.product.sku));

    const wb = new ExcelJS.Workbook();
    wb.creator = "Star Stock";
    wb.created = new Date();
    const ws = wb.addWorksheet(warehouseRow.name.slice(0, 31) || "Warehouse", {
      views: [{ state: "frozen", ySplit: 1 }],
    });

    ws.columns = [
      { header: "SKU", key: "sku", width: 18 },
      { header: "Product Name", key: "name", width: 36 },
      { header: "Stock Unit", key: "unit", width: 12 },
      { header: "Pcs / Carton", key: "perCarton", width: 14 },
      { header: "CTN", key: "ctn", width: 12 },
      { header: "Loose PCS", key: "loose", width: 12 },
      { header: "Total PCS", key: "pcs", width: 12 },
      { header: "Last Updated", key: "updatedAt", width: 22 },
    ];

    const headerRow = ws.getRow(1);
    headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
    headerRow.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF0E6B5C" },
    };
    headerRow.alignment = { vertical: "middle" };

    const dateFmt = "yyyy-mm-dd hh:mm";
    let totalPcs = 0;
    let totalSkus = 0;
    for (const it of items) {
      const per = Math.max(it.product.cartonContains, 1);
      const { cartons, remainder } = splitCartons(it.qtyPieces, per);
      const added = ws.addRow({
        sku: it.product.sku,
        name: it.product.name || "(Unnamed product)",
        unit: it.product.stockUnit === "carton" ? "Carton" : "Piece",
        perCarton: per,
        ctn: cartons,
        loose: remainder,
        pcs: it.qtyPieces,
        updatedAt: it.updatedAt ? new Date(it.updatedAt) : null,
      });
      added.getCell("updatedAt").numFmt = dateFmt;
      totalPcs += it.qtyPieces;
      totalSkus += 1;
    }

    // Format the last-updated column
    ws.getColumn("updatedAt").numFmt = dateFmt;
    // Right-align numeric columns
    for (const key of ["perCarton", "ctn", "loose", "pcs"]) {
      ws.getColumn(key).alignment = { horizontal: "right" };
    }

    // Totals row
    const totalRowIdx = items.length + 2;
    const totalRow = ws.getRow(totalRowIdx);
    totalRow.getCell(1).value = "Totals";
    totalRow.getCell(1).font = { bold: true };
    totalRow.getCell(6).value = "SKUs:";
    totalRow.getCell(6).font = { bold: true };
    totalRow.getCell(6).alignment = { horizontal: "right" };
    totalRow.getCell(7).value = totalSkus;
    totalRow.getCell(7).font = { bold: true };
    totalRow.getCell(7).alignment = { horizontal: "right" };
    totalRow.getCell(8).value = `Total PCS: ${totalPcs}`;
    totalRow.getCell(8).font = { bold: true };

    ws.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: 8 },
    };

    // Small metadata sheet with warehouse info
    const meta = wb.addWorksheet("Info");
    meta.columns = [
      { header: "Field", key: "k", width: 22 },
      { header: "Value", key: "v", width: 40 },
    ];
    meta.getRow(1).font = { bold: true };
    meta.addRow({ k: "Warehouse", v: warehouseRow.name });
    meta.addRow({ k: "Warehouse ID", v: warehouseRow.id });
    const createdRow = meta.addRow({
      k: "Created",
      v: warehouseRow.createdAt ? new Date(warehouseRow.createdAt) : null,
    });
    createdRow.getCell(2).numFmt = dateFmt;
    const exportedRow = meta.addRow({ k: "Exported at", v: new Date() });
    exportedRow.getCell(2).numFmt = dateFmt;
    meta.addRow({ k: "SKUs in stock", v: totalSkus });
    meta.addRow({ k: "Total pieces", v: totalPcs });

    const buffer = await wb.xlsx.writeBuffer();
    const date = new Date().toISOString().slice(0, 10);
    const filename = `${slugify(warehouseRow.name)}-stock-${date}.xlsx`;
    return new Response(new Uint8Array(buffer), {
      headers: {
        "content-type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (e) {
    return errResponse(e);
  }
}
