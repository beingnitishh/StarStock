/**
 * Shared role definitions. This module is dependency-free so it can be
 * imported from both server code (API routes, auth) and client components.
 *
 * - admin      full access, including user management
 * - stock_head / stock_boy   day-to-day stock operations
 * - member     read-only: may only view stock levels and download reports
 */

export type Role = "admin" | "stock_head" | "stock_boy" | "member";

export const ROLES: readonly Role[] = ["admin", "stock_head", "stock_boy", "member"];

export const ROLE_LABELS: Record<Role, string> = {
  admin: "Admin",
  stock_head: "Stock Head",
  stock_boy: "Stock Boy",
  member: "Member",
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  admin: "Full access, including user management.",
  stock_head:
    "Products, inbound/outbound, transfers, adjustments and Excel export.",
  stock_boy:
    "Products, inbound/outbound, transfers, adjustments and Excel export.",
  member:
    "Read-only. Can see current stock in every warehouse and download stock reports, but cannot add, move or edit anything.",
};

/** Roles that may only look at data — never create, edit or move stock. */
export function isReadOnlyRole(role: Role): boolean {
  return role === "member";
}

/** True for roles that are allowed to record stock movements and edits. */
export function canWriteStock(role: Role): boolean {
  return !isReadOnlyRole(role);
}
