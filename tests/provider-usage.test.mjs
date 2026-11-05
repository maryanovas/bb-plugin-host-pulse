import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { createProviderUsageReader, normalizeProviderUsage, providerUsageResponseSchema, selectUsageGroup } from "../lib/provider-usage.ts";

function fixture(overrides = {}) {
  return providerUsageResponseSchema.parse({ machines: [{
    id: "host-1", displayName: "Server", status: "connected", error: null,
    providers: [{ id: "account-1", providerId: "codex", displayName: "Codex", accountLabel: null, usage: {
      status: "ok", accountEmail: "unused@example.test", planLabel: "Pro", windows: [
        { label: "Weekly limit", usedPercent: 16, resetsAt: "2026-11-11T10:00:00Z", cost: null },
      ],
    } }], ...overrides,
  }] });
}

test("normalization preserves consumed percentages, reset times and overage without copying redundant account data", () => {
  const data = fixture();
  data.machines[0].providers[0].accountLabel = "Work account";
  data.machines[0].providers[0].usage.windows[0].usedPercent = 124;
  const result = normalizeProviderUsage(data, "host-1", 100);
  assert.equal(result.status, "ok");
  assert.equal(result.providers[0].windows[0].usedPercent, 124);
  assert.equal(result.providers[0].windows[0].resetsAt, "2026-11-11T10:00:00Z");
  assert.equal(result.providers[0].accountLabel, "Work account");
  assert.ok(!JSON.stringify(result).includes("unused@example.test"));
});

test("multiple accounts remain identifiable when the source only supplies account emails", () => {
  const data = fixture();
  const first = data.machines[0].providers[0];
  first.usage.accountEmail = "first@example.test";
  data.machines[0].providers.push({ ...first, id: "account-2", usage: { ...first.usage, accountEmail: "second@example.test" } });
  const result = normalizeProviderUsage(data, "host-1", 100);
  assert.deepEqual(result.providers.map((p) => p.accountLabel), ["first@example.test", "second@example.test"]);
});

test("independent accounts are not merged and unavailable usage never becomes zero percent", () => {
  const data = fixture();
  data.machines[0].providers.push({ ...data.machines[0].providers[0], id: "account-2", usage: { status: "expired" } });
  const result = normalizeProviderUsage(data, "host-1", 100);
  assert.equal(result.providers.length, 2);
  assert.equal(result.providers[1].status, "expired");
  assert.deepEqual(result.providers[1].windows, []);
  assert.equal(normalizeProviderUsage(data, "gone", 100).status, "unavailable");
});

test("group choice follows Provider usage's shared-account and primary-host order", () => {
  const data = fixture();
  data.machines.unshift({ ...data.machines[0], id: "host-2" });
  assert.equal(selectUsageGroup(data, "host-1").id, "host-1");
  data.machines.push({ ...data.machines[0], id: "source:pool" });
  assert.equal(selectUsageGroup(data, "host-1").id, "source:pool");
  assert.equal(selectUsageGroup({ machines: [] }, null), undefined);
});

test("partial refresh failures and disconnected hosts mark retained values stale", () => {
  assert.equal(normalizeProviderUsage(fixture({ error: "Some data unavailable" }), "host-1", 100).status, "stale");
  assert.equal(normalizeProviderUsage(fixture({ status: "disconnected" }), "host-1", 100).status, "stale");
});

test("concurrent viewers share one inventory/read pair and the minute cache never forces provider refresh", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 100_000 });
  const calls = [];
  const reader = createProviderUsageReader(async (request) => { calls.push(request); return fixture(); }, async () => "host-1");
  t.after(() => reader.dispose());
  assert.equal(calls.length, 0);
  const results = await Promise.all(Array.from({ length: 20 }, () => reader.read()));
  assert.ok(results.every((r) => r === results[0]));
  assert.deepEqual(calls.map((c) => c.providerIds), [[], ["codex"]]);
  assert.deepEqual(calls[1].machineIds, ["host-1"]);
  assert.ok(calls.every((c) => c.force === false && c.maxAgeMs === 60_000));
  t.mock.timers.tick(59_999); await reader.read(); assert.equal(calls.length, 2);
  t.mock.timers.tick(1); await reader.read(); assert.equal(calls.length, 4);
});

test("source failures retain last values and back off for a minute", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 100_000 });
  let fail = false, calls = 0;
  const reader = createProviderUsageReader(async () => { calls++; if (fail) throw new Error("offline"); return fixture(); }, async () => "host-1");
  t.after(() => reader.dispose());
  const good = await reader.read();
  fail = true; t.mock.timers.tick(60_000);
  const stale = await reader.read();
  assert.equal(stale.status, "stale");
  assert.equal(stale.checkedAt, good.checkedAt);
  assert.deepEqual(stale.providers, good.providers);
  await reader.read(); assert.equal(calls, 3);
  fail = false; t.mock.timers.tick(60_000);
  assert.equal((await reader.read()).status, "ok");
});

test("a missing Provider usage plugin produces an unavailable block, not invented quotas", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 100_000 });
  const reader = createProviderUsageReader(async () => { throw new Error("not installed"); }, async () => "host-1");
  t.after(() => reader.dispose());
  const result = await reader.read();
  assert.equal(result.status, "unavailable");
  assert.equal(result.checkedAt, null);
  assert.deepEqual(result.providers, []);
  t.mock.timers.tick(60_000);
  assert.equal((await reader.read()).status, "unavailable");
});

test("disposal aborts outstanding calls and prevents late cache revival", async () => {
  let resolve, signal;
  const pending = new Promise((r) => { resolve = r; });
  const reader = createProviderUsageReader((_input, s) => { signal = s; return pending; }, async () => "host-1");
  const request = reader.read();
  reader.dispose();
  assert.equal(signal.aborted, true);
  resolve(fixture());
  await assert.rejects(request, { name: "AbortError" });
  await assert.rejects(reader.read(), /disposed/);
});

test("the primary-host SDK lookup receives the same timeout and disposal signal as quota RPCs", async (t) => {
  let configSignal, usageSignal;
  const { bb, harness } = createFakePluginHost({ pluginId: "host-pulse", sdk: {
    plugins: { callRpc: async ({ signal }) => { usageSignal = signal; return fixture(); } },
    system: { config: async (options) => { configSignal = options?.signal; return { primaryHostId: "host-1" }; } },
  } });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  assert.equal((await harness.behavior.callRpc("provider_usage_snapshot", null)).status, "ok");
  assert.ok(configSignal instanceof AbortSignal);
  assert.equal(configSignal, usageSignal);
  await harness.lifecycle.dispose();
  assert.equal(configSignal.aborted, true);
});

test("invalid source values fail validation rather than displaying misleading limits", () => {
  const data = fixture();
  data.machines[0].providers[0].usage.windows[0].usedPercent = -1;
  assert.throws(() => providerUsageResponseSchema.parse(data));
});

test("quota RPC failures do not prevent ordinary server metric snapshots", async (t) => {
  // Unstubbed SDK calls fail. The independent quota reader must contain that failure.
  const { bb, harness } = createFakePluginHost({ pluginId: "host-pulse" });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  const usage = await harness.behavior.callRpc("provider_usage_snapshot", null);
  assert.equal(usage.status, "unavailable");
  const metrics = await harness.behavior.callRpc("metrics_snapshot", null);
  assert.ok(metrics.cpu.cores > 0);
  assert.ok(metrics.memory.totalBytes > 0);
});
