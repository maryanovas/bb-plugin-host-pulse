import { z } from "zod";

export const PROVIDER_USAGE_INTERVAL = 60_000;
const windowSchema = z.object({
  label: z.string().min(1).max(240),
  usedPercent: z.number().nonnegative(),
  resetsAt: z.string().nullable(),
  cost: z.object({ usedUsdCents: z.number().nonnegative(), limitUsdCents: z.number().positive() }).nullable(),
});
const usageSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), planLabel: z.string().nullable(), accountEmail: z.string().nullable().optional(), windows: z.array(windowSchema).max(64) }),
  z.object({ status: z.enum(["not_installed", "unauthenticated", "expired", "error"]) }),
]);

// Public getUsage RPC of BB's installed Provider usage plugin. Extra identity,
// branding and unused account metadata are intentionally not copied into Host Pulse.
// Email is used only when the source supplies no display label for an account.
export const providerUsageResponseSchema = z.object({ machines: z.array(z.object({
  id: z.string(), displayName: z.string(), status: z.enum(["connected", "disconnected"]), error: z.string().nullable(),
  providers: z.array(z.object({ id: z.string(), providerId: z.string(), displayName: z.string(), accountLabel: z.string().nullable(), usage: usageSchema.nullable() })).max(256),
})).max(256) });
export type SourceProviderUsage = z.infer<typeof providerUsageResponseSchema>;
export interface ProviderUsageRequest { force: false; machineIds: string[] | null; providerIds: string[]; maxAgeMs: number }

export const providerUsageSnapshotSchema = z.object({
  status: z.enum(["ok", "stale", "unavailable"]),
  checkedAt: z.number().nullable(),
  groupLabel: z.string().nullable(),
  refreshIntervalMs: z.literal(PROVIDER_USAGE_INTERVAL),
  providers: z.array(z.object({
    id: z.string(), label: z.string(), accountLabel: z.string().nullable(), planLabel: z.string().nullable(),
    status: z.enum(["ok", "not_installed", "unauthenticated", "expired", "error", "unknown"]),
    windows: z.array(windowSchema).max(64),
  })).max(256),
});
export type ProviderUsageSnapshot = z.infer<typeof providerUsageSnapshotSchema>;

/** Same default group preference as Provider usage: shared accounts, then the primary host. */
export function selectUsageGroup(data: SourceProviderUsage, primaryHostId: string | null) {
  return data.machines.find((m) => m.id.startsWith("source:") && (m.error === null || m.providers.length > 0))
    ?? data.machines.find((m) => m.id === primaryHostId)
    ?? data.machines.find((m) => m.status === "connected")
    ?? data.machines[0];
}

export function normalizeProviderUsage(data: SourceProviderUsage, groupId: string | null, now: number): ProviderUsageSnapshot {
  const group = data.machines.find((m) => m.id === groupId);
  return {
    status: !group ? "unavailable" : group.error || group.status !== "connected" ? "stale" : "ok",
    checkedAt: now,
    groupLabel: group?.displayName ?? null,
    refreshIntervalMs: PROVIDER_USAGE_INTERVAL,
    // Keep independent accounts independent; never average their quota percentages.
    providers: (group?.providers ?? []).map((provider) => ({
      id: provider.id, label: provider.displayName,
      accountLabel: provider.accountLabel?.trim() || (provider.usage?.status === "ok" ? provider.usage.accountEmail?.trim() : null) || null,
      planLabel: provider.usage?.status === "ok" ? provider.usage.planLabel : null,
      status: provider.usage?.status ?? "unknown",
      windows: provider.usage?.status === "ok" ? provider.usage.windows : [],
    })),
  };
}

/** Shared, demand-driven minute cache. Quota lookups never block server metrics. */
export function createProviderUsageReader(
  fetchUsage: (input: ProviderUsageRequest, signal: AbortSignal) => Promise<SourceProviderUsage>,
  getPrimaryHost: (signal: AbortSignal) => Promise<string | null>,
) {
  const lifecycle = new AbortController();
  let cached: ProviderUsageSnapshot | null = null;
  let pending: Promise<ProviderUsageSnapshot> | null = null;
  let nextAttemptAt = 0;
  async function collect(): Promise<ProviderUsageSnapshot> {
    const signal = AbortSignal.any([lifecycle.signal, AbortSignal.timeout(20_000)]);
    try {
      const [inventory, primaryHost] = await Promise.all([
        fetchUsage({ force: false, machineIds: null, providerIds: [], maxAgeMs: PROVIDER_USAGE_INTERVAL }, signal),
        getPrimaryHost(signal).catch(() => null),
      ]);
      signal.throwIfAborted();
      const group = selectUsageGroup(inventory, primaryHost);
      const ids = [...new Set(group?.providers.map((p) => p.providerId) ?? [])];
      const data = group?.status === "connected" && ids.length
        ? await fetchUsage({ force: false, machineIds: [group.id], providerIds: ids, maxAgeMs: PROVIDER_USAGE_INTERVAL }, signal)
        : inventory;
      signal.throwIfAborted();
      cached = normalizeProviderUsage(data, group?.id ?? null, Date.now());
      return cached;
    } catch {
      lifecycle.signal.throwIfAborted();
      cached = cached && cached.status !== "unavailable" ? { ...cached, status: "stale" } : {
        status: "unavailable", checkedAt: null, groupLabel: null, refreshIntervalMs: PROVIDER_USAGE_INTERVAL, providers: [],
      };
      return cached;
    } finally { nextAttemptAt = Date.now() + PROVIDER_USAGE_INTERVAL; }
  }
  return {
    read(): Promise<ProviderUsageSnapshot> {
      if (lifecycle.signal.aborted) return Promise.reject(new Error("Provider usage reader disposed"));
      if (pending) return pending;
      if (cached && Date.now() < nextAttemptAt) return Promise.resolve(cached);
      pending = collect().finally(() => { pending = null; });
      return pending;
    },
    dispose() { lifecycle.abort(); cached = null; },
  };
}
