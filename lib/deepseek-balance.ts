import { createHash } from "node:crypto";
import { DEEPSEEK_BALANCE_INTERVAL, deepseekBalanceResponseSchema, type DeepseekBalanceSnapshot } from "./deepseek-balance-schema.ts";
export { DEEPSEEK_BALANCE_INTERVAL, deepseekBalanceResponseSchema, deepseekBalanceSnapshotSchema, type DeepseekBalanceSnapshot } from "./deepseek-balance-schema.ts";

/** No background timer: all viewers share one request and a ten-second cache. */
export function createDeepseekBalanceReader(
  getApiKey: (signal: AbortSignal) => Promise<string | null>,
  request: typeof fetch = fetch,
) {
  const lifecycle = new AbortController();
  let cached: DeepseekBalanceSnapshot | null = null;
  let pending: Promise<DeepseekBalanceSnapshot> | null = null;
  let nextAttemptAt = 0;
  let account: string | null = null;
  function empty(status: DeepseekBalanceSnapshot["status"]): DeepseekBalanceSnapshot {
    return { status, checkedAt: null, refreshIntervalMs: DEEPSEEK_BALANCE_INTERVAL, isAvailable: null, balances: [] };
  }
  async function collect(): Promise<DeepseekBalanceSnapshot> {
    const signal = AbortSignal.any([lifecycle.signal, AbortSignal.timeout(8000)]);
    let credentialsResolved = false;
    try {
      const apiKey = await getApiKey(signal);
      signal.throwIfAborted();
      const identity = apiKey ? createHash("sha256").update(apiKey).digest("hex") : null;
      // A changed key must never inherit another account's balance after a failure.
      if (identity !== account) { cached = null; account = identity; }
      credentialsResolved = true;
      if (!apiKey) return cached = empty("not_configured");
      const response = await request("https://api.deepseek.com/user/balance", {
        method: "GET", headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        signal, redirect: "error", cache: "no-store",
      });
      signal.throwIfAborted();
      if (!response.ok) {
        await response.body?.cancel();
        signal.throwIfAborted();
        if (response.status === 401 || response.status === 403) return cached = empty("unauthenticated");
        throw new Error("Balance unavailable");
      }
      const body = await response.text();
      signal.throwIfAborted();
      if (body.length > 16_384) throw new Error("Balance response too large");
      const result = deepseekBalanceResponseSchema.parse(JSON.parse(body));
      return cached = {
        status: "ok", checkedAt: Date.now(), refreshIntervalMs: DEEPSEEK_BALANCE_INTERVAL,
        isAvailable: result.is_available, balances: result.balance_infos,
      };
    } catch {
      lifecycle.signal.throwIfAborted();
      // A resolver failure can mean the account/configuration changed. Only a
      // failed API call with a confirmed same key may retain an old balance.
      if (!credentialsResolved) { cached = null; account = null; }
      // Never return raw provider errors, headers, credential files or the key.
      return cached = cached?.balances.length ? { ...cached, status: "stale" } : empty("unavailable");
    } finally { nextAttemptAt = Date.now() + DEEPSEEK_BALANCE_INTERVAL; }
  }
  return {
    read(): Promise<DeepseekBalanceSnapshot> {
      if (lifecycle.signal.aborted) return Promise.reject(new Error("DeepSeek balance reader disposed"));
      if (pending) return pending;
      if (cached && Date.now() < nextAttemptAt) return Promise.resolve(cached);
      pending = collect().finally(() => { pending = null; });
      return pending;
    },
    dispose() { lifecycle.abort(); cached = null; account = null; },
  };
}
