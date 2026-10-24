import type { Role } from "./roles";
import type { ApplicationSource } from "./source-app";

export {
  canWriteStock,
  isReadOnlyRole,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  ROLES,
  type Role,
} from "./roles";

export type SessionUser = {
  id: number;
  username: string;
  displayName: string;
  role: Role;
};

export type Warehouse = {
  id: number;
  name: string;
  createdBy: number | null;
  createdAt: string;
};

export type ProductStock = {
  warehouseId: number;
  warehouseName: string;
  qtyPieces: number;
};

export type ProductRow = {
  id: number;
  sku: string;
  name: string;
  imageUrl: string;
  stockUnit: "piece" | "carton";
  cartonContains: number;
  openingStockPieces: number;
  createdAt: string;
  totalPieces: number;
  stocks: ProductStock[];
};

export type OpType = "inbound" | "outbound" | "transfer" | "adjustment";

export type TxRow = {
  id: number;
  type: OpType;
  enteredQty: number;
  enteredUnit: "piece" | "carton";
  qtyPieces: number;
  destination: string | null;
  reason: string | null;
  sourceApp: ApplicationSource;
  previousTotalPieces: number | null;
  clientRequestId: string | null;
  resultingTotalPieces: number;
  createdAt: string;
  productId: number;
  sku: string;
  productName: string;
  cartonContains: number;
  userName: string | null;
  warehouseName: string | null;
  toWarehouseName: string | null;
};
