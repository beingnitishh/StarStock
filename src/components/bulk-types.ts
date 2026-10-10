export type BulkResult = {
  created: number;
  failed: number;
  errors: Array<{ row: number; sku: string; message: string }>;
};
