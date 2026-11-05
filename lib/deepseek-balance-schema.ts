import { z } from "zod";

export const DEEPSEEK_BALANCE_INTERVAL = 10_000;
const amountSchema = z.string().regex(/^-?\d{1,18}(?:\.\d{1,12})?$/);
const balanceSchema = z.object({
  currency: z.enum(["USD", "CNY"]),
  total_balance: amountSchema,
  granted_balance: amountSchema,
  topped_up_balance: amountSchema,
});
// https://api-docs.deepseek.com/api/get-user-balance/
export const deepseekBalanceResponseSchema = z.object({
  is_available: z.boolean(),
  balance_infos: z.array(balanceSchema).min(1).max(2).refine((balances) => new Set(balances.map((b) => b.currency)).size === balances.length),
});
export const deepseekBalanceSnapshotSchema = z.object({
  status: z.enum(["ok", "stale", "unavailable", "not_configured", "unauthenticated"]),
  checkedAt: z.number().nullable(),
  refreshIntervalMs: z.literal(DEEPSEEK_BALANCE_INTERVAL),
  isAvailable: z.boolean().nullable(),
  balances: z.array(balanceSchema).max(2),
});
export type DeepseekBalanceSnapshot = z.infer<typeof deepseekBalanceSnapshotSchema>;
