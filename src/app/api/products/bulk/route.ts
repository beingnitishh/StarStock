import { asc } from "drizzle-orm";
import ExcelJS from "exceljs";
import { db } from "@/db";
import { products, warehouses } from "@/db/schema";
import { errResponse, HttpError, readJson, requireUser, requireWriter } from "@/lib/api";
import { parseCsv } from "@/lib/csv";
import { deleteProducts, isAllWarehouses, registerProduct } from "@/lib/products";
import type { StockUnit } from "@/lib/units";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Template download (XLSX with dropdowns)
// ---------------------------------------------------------------------------
export async function GET() {
  try {
    await requireUser();
    const warehouseRows = await db
      .select()
      .from(warehouses)
      .orderBy(asc(warehouses.id));

    const wb = new ExcelJS.Workbook();
    wb.creator = "Star Stock";
    wb.created = new Date();

    // Main sheet
    const ws = wb.addWorksheet("Products", {
      views: [{ state: "frozen", ySplit: 1 }],
      properties: { tabColor: { argb: "FF0E6B5C" } },
    });

    ws.columns = [
      { header: "SKU", key: "sku", width: 16 },
      { header: "Product Name", key: "name", width: 30 },
      { header: "Image URL", key: "image", width: 36 },
      { header: "Opening Stock", key: "opening", width: 14 },
      { header: "Unit", key: "unit", width: 12 },
      { header: "Carton Contains", key: "carton", width: 16 },
      { header: "Warehouse", key: "warehouse", width: 24 },
    ] as Partial<ExcelJS.Column>[];

    const headerRow = ws.getRow(1);
    headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
    headerRow.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF0E6B5C" },
    };
    headerRow.alignment = { vertical: "middle", horizontal: "center" };
    headerRow.commit();

    const firstWh = warehouseRows[0]?.name ?? "Main Warehouse";
    // Example rows demonstrating single warehouse and All Warehouses
    ws.addRow({
      sku: "BTL-750",
      name: "Sparkling Water 750ml",
      image: "https://example.com/water.jpg",
      opening: 10,
      unit: "carton",
      carton: 24,
      warehouse: firstWh,
    });
    ws.addRow({
      sku: "TEA-100",
      name: "Black Tea 100 Bags",
      image: "",
      opening: 120,
      unit: "piece",
      carton: 12,
      warehouse: "All Warehouses",
    });
    // Add an empty row for user to start typing, but with helpful placeholder
    // (leave it blank so validation still works)

    // Style example rows faintly
    for (let r = 2; r <= 3; r++) {
      const row = ws.getRow(r);
      row.eachCell((cell) => {
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFF6F8F6" },
        };
        cell.font = { color: { argb: "FF52525B" }, size: 11 };
      });
    }

    // Instructions / note row (row 5 onward could be instructions, but keep sheet clean)
    // Auto filter
    ws.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: 7 },
    };

    // Freeze + basic protections: allow all but give hints
    // Add comments to header cells
    ws.getCell("G1").note = "Choose a warehouse or All Warehouses to stock in every warehouse.";
    ws.getCell("E1").note = "Choose piece or carton.";

    // Data validations: Unit and Warehouse downgroups
    // Hidden list sheet for warehouses
    const lists = wb.addWorksheet("Lists");
    // Populate warehouse names + All Warehouses
    // Use A column for warehouse list
    let listIdx = 1;
    for (const w of warehouseRows) {
      lists.getCell(`A${listIdx}`).value = w.name;
      listIdx++;
    }
    // Always add All Warehouses as last option (not default, but available in dropdown)
    lists.getCell(`A${listIdx}`).value = "All Warehouses";
    const warehouseListEndRow = listIdx;
    // Make lists sheet very hidden so users don't accidentally edit it, but dropdown still works
    lists.state = "veryHidden";

    const lastDataRow = 1000;

    // Unit validation: piece,carton
    // Use direct list formula
    try {
      (ws as unknown as { dataValidations: { add: (ref: string, v: unknown) => void } }).dataValidations.add(
        `E2:E${lastDataRow}`,
        {
          type: "list",
          allowBlank: true,
          formulae: ['"piece,carton"'],
          showErrorMessage: true,
          errorTitle: "Invalid unit",
          error: 'Please select "piece" or "carton" from the dropdown.',
          showDropDown: false,
        },
      );
    } catch {
      // ExcelJS version may not support dataValidations — ignore
    }

    // Warehouse validation: reference hidden list
    try {
      (ws as unknown as { dataValidations: { add: (ref: string, v: unknown) => void } }).dataValidations.add(
        `G2:G${lastDataRow}`,
        {
          type: "list",
          allowBlank: true,
          formulae: [`Lists!$A$1:$A$${warehouseListEndRow}`],
          showErrorMessage: true,
          errorTitle: "Invalid warehouse",
          error: "Pick a warehouse from the dropdown or choose All Warehouses.",
          showDropDown: false,
        },
      );
    } catch {
      // ignore if not supported
    }

    // Add an Instructions sheet
    const instr = wb.addWorksheet("Instructions");
    instr.columns = [
      { header: "Instructions", key: "k", width: 24 },
      { header: "Details", key: "v", width: 60 },
    ];
    instr.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    instr.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF0E6B5C" },
    };
    instr.addRow({ k: "SKU", v: "Required, unique. 1-60 characters. Example: BTL-750" });
    instr.addRow({ k: "Product Name", v: "Optional, max 120 characters." });
    instr.addRow({ k: "Image URL", v: "Optional, must start with http:// or https://" });
    instr.addRow({ k: "Opening Stock", v: "Required, whole number 0 or more. Applied in the chosen warehouse entry." });
    instr.addRow({ k: "Unit", v: "Required. Choose piece or carton from dropdown." });
    instr.addRow({ k: "Carton Contains", v: "Required, whole number >=1. Pieces per carton." });
    instr.addRow({
      k: "Warehouse",
      v: "Required if opening stock >0. Select a warehouse name from dropdown or choose All Warehouses to create stock in every warehouse.",
    });
    instr.addRow({ k: "All Warehouses", v: "When selected, the product's opening stock is replicated to every warehouse that exists. It will appear in inventory under each warehouse." });
    instr.addRow({ k: "File format", v: "Save as .xlsx or .csv. Both are accepted on upload." });

    const buffer = await wb.xlsx.writeBuffer();
    return new Response(buffer as unknown as ArrayBuffer, {
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": 'attachment; filename="star-stock-bulk-template.xlsx"',
      },
    });
  } catch (e) {
    return errResponse(e);
  }
}

type CellValue = ExcelJS.CellValue;

function cellText(v: CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    const obj = v as unknown as Record<string, unknown>;
    if (Array.isArray(obj.richText)) {
      return (obj.richText as Array<{ text?: string }>)
        .map((r) => r.text ?? "")
        .join("");
    }
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.hyperlink === "string") return obj.hyperlink;
  }
  return String(v);
}

function headerKey(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const HEADER_ALIASES: Record<string, string> = {
  sku: "sku",
  skucode: "sku",
  name: "name",
  productname: "name",
  product: "name",
  title: "name",
  image: "image",
  imageurl: "image",
  imagelink: "image",
  picture: "image",
  photourl: "image",
  openingstock: "opening",
  opening: "opening",
  openingqty: "opening",
  openingquantity: "opening",
  unit: "unit",
  stockunit: "unit",
  quantityunit: "unit",
  cartoncontains: "carton",
  cartoncontainspcs: "carton",
  piecespercarton: "carton",
  pcspercarton: "carton",
  cartonsize: "carton",
  warehouse: "warehouse",
  warehousename: "warehouse",
  openingstockwarehouse: "warehouse",
};

function parseUnitLoose(raw: string): StockUnit | null {
  const v = raw.trim().toLowerCase();
  if (["piece", "pieces", "pcs", "pc"].includes(v)) return "piece";
  if (["carton", "cartons", "ctn", "ctns", "box", "boxes"].includes(v)) return "carton";
  return null;
}

export async function POST(req: Request) {
  try {
    const user = await requireWriter();
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new HttpError(400, "Attach a CSV or XLSX file to upload.");
    }
    const lower = file.name.toLowerCase();

    let grid: string[][] = [];
    if (lower.endsWith(".csv")) {
      grid = parseCsv(await file.text());
    } else if (lower.endsWith(".xlsx") || lower.endsWith(".xlsm")) {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(await file.arrayBuffer());
      const sheet = wb.worksheets[0];
      if (sheet) {
        sheet.eachRow({ includeEmpty: false }, (row) => {
          const cells: string[] = [];
          row.eachCell({ includeEmpty: true }, (cell) => {
            cells.push(cellText(cell.value).trim());
          });
          grid.push(cells);
        });
      }
    } else {
      throw new HttpError(400, "Unsupported file type. Upload a .csv or .xlsx file.");
    }

    if (grid.length < 2) {
      throw new HttpError(400, "The file has no data rows. Use the template to add products.");
    }

    const [defaultWh, allWarehouses, existingProducts] = await Promise.all([
      db.select().from(warehouses).orderBy(asc(warehouses.createdAt)).limit(1),
      db.select().from(warehouses),
      db.select({ sku: products.sku }).from(products),
    ]);
    const defaultWarehouse = defaultWh[0];
    if (!defaultWarehouse) {
      throw new HttpError(400, "Create a warehouse before bulk listing products.");
    }
    const existingSkus = new Set(existingProducts.map((p) => p.sku.toLowerCase()));
    const warehouseByName = new Map(
      allWarehouses.map((w) => [w.name.toLowerCase(), w]),
    );

    const headers = grid[0].map(headerKey);
    const colIndex: Record<string, number> = {};
    headers.forEach((h, i) => {
      const mapped = HEADER_ALIASES[h];
      if (mapped && colIndex[mapped] === undefined) colIndex[mapped] = i;
    });
    if (colIndex.sku === undefined) {
      throw new HttpError(400, 'The file must have a "SKU" column header.');
    }

    const errors: Array<{ row: number; sku: string; message: string }> = [];
    const seenInFile = new Set<string>();
    const valid: Array<{
      row: number;
      sku: string;
      name: string;
      imageUrl: string;
      stockUnit: StockUnit;
      cartonContains: number;
      openingQty: number;
      warehouseId: number | "ALL";
    }> = [];

    const cell = (row: string[], key: string) => {
      const i = colIndex[key];
      return i === undefined ? "" : (row[i] ?? "").trim();
    };

    for (let r = 1; r < grid.length; r++) {
      const row = grid[r];
      const rowNo = r + 1;
      const sku = cell(row, "sku");
      const rowErrors: string[] = [];

      if (!sku) rowErrors.push("SKU is required.");
      else if (sku.length > 60) rowErrors.push("SKU is longer than 60 characters.");
      else if (existingSkus.has(sku.toLowerCase()))
        rowErrors.push(`SKU already exists in the catalog.`);
      else if (seenInFile.has(sku.toLowerCase()))
        rowErrors.push(`SKU appears more than once in this file.`);

      const unitRaw = cell(row, "unit");
      const stockUnit = parseUnitLoose(unitRaw);
      if (!stockUnit)
        rowErrors.push(`Unit "${unitRaw || "(blank)"}" must be "piece" or "carton".`);

      const cartonRaw = cell(row, "carton");
      const cartonContains = Number(cartonRaw);
      if (!cartonRaw || !Number.isInteger(cartonContains) || cartonContains < 1) {
        rowErrors.push("Carton Contains must be a whole number of at least 1.");
      }

      const openingRaw = cell(row, "opening");
      const openingQty = Number(openingRaw);
      if (openingRaw === "" || !Number.isInteger(openingQty) || openingQty < 0) {
        rowErrors.push("Opening Stock must be a whole number of 0 or more.");
      }

      const imageUrl = cell(row, "image");
      if (imageUrl && !/^https?:\/\//i.test(imageUrl)) {
        rowErrors.push("Image URL must start with http:// or https://");
      }

      let warehouseId: number | "ALL" = defaultWarehouse.id;
      const whName = cell(row, "warehouse");
      if (whName) {
        if (isAllWarehouses(whName)) {
          warehouseId = "ALL";
        } else {
          const wh = warehouseByName.get(whName.toLowerCase());
          if (!wh) rowErrors.push(`Unknown warehouse "${whName}". Use a name from the dropdown or "All Warehouses".`);
          else warehouseId = wh.id;
        }
      }

      if (rowErrors.length > 0) {
        errors.push({ row: rowNo, sku, message: rowErrors.join(" ") });
      } else {
        seenInFile.add(sku.toLowerCase());
        valid.push({
          row: rowNo,
          sku,
          name: cell(row, "name").slice(0, 120),
          imageUrl: imageUrl.slice(0, 2000),
          stockUnit: stockUnit as StockUnit,
          cartonContains,
          openingQty,
          warehouseId,
        });
      }
    }

    let created = 0;
    for (const v of valid) {
      try {
        await registerProduct(
          {
            sku: v.sku,
            name: v.name,
            imageUrl: v.imageUrl,
            stockUnit: v.stockUnit,
            cartonContains: v.cartonContains,
            openingQty: v.openingQty,
            warehouseId: v.warehouseId,
          },
          user.id,
        );
        created++;
      } catch (e) {
        errors.push({
          row: v.row,
          sku: v.sku,
          message: e instanceof Error ? e.message : "Failed to create product.",
        });
      }
    }

    return Response.json({ created, failed: errors.length, errors });
  } catch (e) {
    return errResponse(e);
  }
}

/** Delete a selected group of products, provided none still hold stock. */
export async function DELETE(req: Request) {
  try {
    await requireWriter();
    const body = await readJson(req);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new HttpError(400, "Request body must be a JSON object with selected product IDs.");
    }
    const rawIds = body.ids;
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      throw new HttpError(400, "Select at least one product to delete.");
    }
    if (rawIds.length > 5000) {
      throw new HttpError(400, "Delete at most 5,000 products at a time.");
    }

    const ids = rawIds.map((value) => {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw new HttpError(400, "Selected product IDs must be positive whole numbers.");
      }
      return value;
    });
    const deleted = await deleteProducts(ids);
    return Response.json({ ok: true, deleted });
  } catch (e) {
    return errResponse(e);
  }
}
