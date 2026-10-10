export type TxType = "inbound" | "outbound" | "transfer" | "adjustment";

export const TX_META: Record<
  TxType,
  { label: string; chip: string; dot: string; sign: "+" | "-" | "=" }
> = {
  inbound: { label: "Inbound", chip: "bg-in-soft text-in", dot: "bg-in", sign: "+" },
  outbound: { label: "Outbound", chip: "bg-out-soft text-out", dot: "bg-out", sign: "-" },
  transfer: { label: "Transfer", chip: "bg-move-soft text-move", dot: "bg-move", sign: "=" },
  adjustment: { label: "Adjustment", chip: "bg-adj-soft text-adj", dot: "bg-adj", sign: "=" },
};
