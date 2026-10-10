import { asc } from "drizzle-orm";
import ExcelJS from "exceljs";
import { db } from "@/db";
import { warehouses } from "@/db/schema";
import { errResponse, requireUser } from "@/lib/api";
import { fetchProductRows } from "@/lib/query";
import { splitCartons } from "@/lib/units";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireUser();
    const [productRows, warehouseRows] = await Promise.all([
      fetchProductRows(),
      db.select().from(warehouses).orderBy(asc(warehouses.id)),
    ]);

    const wb = new ExcelJS.Workbook();
    wb.creator = "Star Stock";
    wb.created = new Date();
    const ws = wb.addWorksheet("Current Stock", {
      views: [{ state: "frozen", ySplit: 1 }],
    });

    const columns: Array<Partial<ExcelJS.Column>> = [
      { header: "SKU", key: "sku", width: 16 },
      { header: "Product Name", key: "name", width: 30 },
      { header: "Stock Unit", key: "unit", width: 10 },
      { header: "Pcs / Carton", key: "perCarton", width: 12 },
    ];
    for (const w of warehouseRows) {
      columns.push({ header: `${w.name} (CTN)`, key: `w${w.id}_ctn`, width: 18 });
      columns.push({ header: `${w.name} (PCS)`, key: `w${w.id}_pcs`, width: 18 });
    }
    columns.push({ header: "Total CTN", key: "totalCtn", width: 12 });
    columns.push({ header: "Total PCS", key: "totalPcs", width: 12 });
    ws.columns = columns;

    const headerRow = ws.getRow(1);
    headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
    headerRow.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF0E6B5C" },
    };
    headerRow.alignment = { vertical: "middle" };

    for (const p of productRows) {
      const per = Math.max(p.cartonContains, 1);
      const byWh = new Map(p.stocks.map((s) => [s.warehouseId, s.qtyPieces]));
      const row: Record<string, string | number> = {
        sku: p.sku,
        name: p.name,
        unit: p.stockUnit === "carton" ? "Carton" : "Piece",
        perCarton: per,
      };
      for (const w of warehouseRows) {
        const qty = byWh.get(w.id) ?? 0;
        row[`w${w.id}_ctn`] = splitCartons(qty, per).cartons;
        row[`w${w.id}_pcs`] = qty;
      }
      row.totalCtn = splitCartons(p.totalPieces, per).cartons;
      row.totalPcs = p.totalPieces;
      ws.addRow(row);
    }

    ws.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: columns.length },
    };

    const buffer = await wb.xlsx.writeBuffer();
    const date = new Date().toISOString().slice(0, 10);
    return new Response(new Uint8Array(buffer), {
      headers: {
        "content-type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="star-stock-${date}.xlsx"`,
      },
    });
  } catch (e) {
    return errResponse(e);
  }
}
