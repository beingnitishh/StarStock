export type BulkResult = {
  created: number;
  failed: number;
  errors: Array<{ row: number; sku: string; message: string }>;
  hasMoreErrors?: boolean;
  totalErrors?: number;
  summary?: Array<{ message: string; count: number }>;
  historyId?: number | null;
  totalRows?: number;
};
