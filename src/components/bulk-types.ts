export type BulkImageIssue = {
  sku: string;
  fileName: string;
  message: string;
};

export type BulkImageReport = {
  /** Photos saved and now visible on the product. */
  attached: number;
  /** Photos that could not be attached (decode/upload/match failures). */
  failed: number;
  errors: BulkImageIssue[];
  total: number;
};

export type BulkResult = {
  created: number;
  failed: number;
  errors: Array<{ row: number; sku: string; message: string }>;
  hasMoreErrors?: boolean;
  totalErrors?: number;
  summary?: Array<{ message: string; count: number }>;
  historyId?: number | null;
  totalRows?: number;
  /** Row number → SKU for the rows that were created, used to match photos. */
  createdItems?: Array<{ row: number; sku: string }>;
  images?: BulkImageReport;
};
