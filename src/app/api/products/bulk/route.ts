import { asc, eq } from "drizzle-orm";
import ExcelJS from "exceljs";
import { db } from "@/db";
import { products, warehouses } from "@/db/schema";
import { errResponse, HttpError, requireUser, requireWriter } from "@/lib/api";
import { parseCsv } from "@/lib/csv";
import { registerProduct } from "@/lib/products";
import type { StockUnit } from "@/lib/units";

export const dynamic = "force-dynamic";

const TEMPLATE = [
  "SKU,Product Name,Image URL,Opening Stock,Unit,Carton Contains,Warehouse",
  "BTL-750,Sparkling Water 750ml,https://example.com/water.jpg,10,carton,24,Main Warehouse",
  "TEA-100,Black Tea 100 Bags,,120,piece,12,Main Warehouse",
].join("\n");

export async function GET() {
  try {
    await requireUser();
    return new Response(TEMPLATE, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="star-stock-bulk-template.csv"',
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
      warehouseId: number;
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

      let warehouseId = defaultWarehouse.id;
      const whName = cell(row, "warehouse");
      if (whName) {
        const wh = warehouseByName.get(whName.toLowerCase());
        if (!wh) rowErrors.push(`Unknown warehouse "${whName}".`);
        else warehouseId = wh.id;
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
