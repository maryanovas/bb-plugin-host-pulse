import { test } from "node:test";
import assert from "node:assert/strict";
import { createHostPulseRpcClient } from "../lib/host-pulse-rpc.ts";
import { createSnapshotSource } from "../lib/snapshot-source.ts";
import { createVisiblePoller } from "../lib/visible-poller.ts";

const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const balance = (checkedAt = 1) => ({ status: "not_configured", checkedAt, refreshIntervalMs: 10_000, isAvailable: null, balances: [] });

test("a stalled shared RPC is aborted after thirty seconds and both viewers recover after backoff", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100_000 });
  const requests = [], received = [[], []], errors = [[], []];
  const rpc = createHostPulseRpcClient({ callRpc: (request) => {
    requests.push(request);
    if (requests.length > 1) return Promise.resolve(request.outputSchema.parse(balance()));
    return new Promise((_resolve, reject) => request.signal?.addEventListener("abort", () => reject(request.signal.reason), { once: true }));
  } }, "host-pulse");
  const source = createSnapshotSource((value) => value.refreshIntervalMs);
  const pollers = received.map((values, index) => createVisiblePoller({
    load: () => source.load(() => rpc.call("deepseek_balance_snapshot")),
    receive: (value) => values.push(value), error: (error) => errors[index].push(error),
    intervalMs: (value) => value.refreshIntervalMs,
  }));
  t.after(() => pollers.forEach((poller) => poller.dispose()));
  pollers.forEach((poller) => poller.setActive(true));
  await flush();
  assert.equal(requests.length, 1);
  t.mock.timers.tick(29_999); await flush();
  assert.deepEqual(errors.map((values) => values.length), [0, 0]);
  t.mock.timers.tick(1); await flush();
  assert.deepEqual(errors.map((values) => values.length), [1, 1]);
  assert.equal(requests[0].signal.aborted, true);
  assert.match(errors[0][0].message, /timed out/i);
  assert.equal(source.snapshot(), null);
  t.mock.timers.tick(4999); await flush();
  assert.equal(requests.length, 1);
  t.mock.timers.tick(1); await flush();
  assert.equal(requests.length, 2);
  assert.deepEqual(received, [[balance()], [balance()]]);
  assert.equal(source.snapshot(), received[0][0]);
});

test("closing one viewer preserves the shared request for the remaining viewer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100_000 });
  let request, finish, calls = 0;
  const rpc = createHostPulseRpcClient({ callRpc: (next) => {
    calls++; request = next;
    return new Promise((resolve) => { finish = resolve; });
  } }, "host-pulse");
  const source = createSnapshotSource((value) => value.refreshIntervalMs);
  const received = [[], []];
  const pollers = received.map((values) => createVisiblePoller({
    load: () => source.load(() => rpc.call("deepseek_balance_snapshot")),
    receive: (value) => values.push(value), error: assert.fail,
    intervalMs: (value) => value.refreshIntervalMs,
  }));
  t.after(() => pollers.forEach((poller) => poller.dispose()));
  pollers.forEach((poller) => poller.setActive(true));
  await flush();
  t.mock.timers.tick(10_000);
  pollers[0].dispose();
  assert.equal(request.signal.aborted, false);
  assert.equal(calls, 1);
  finish(balance()); await flush();
  assert.deepEqual(received, [[], [balance()]]);
});

test("a response delivered at the expired deadline cannot replace cached data or a later recovery", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100_000 });
  let calls = 0;
  const rpc = createHostPulseRpcClient({ callRpc: (request) => {
    calls++;
    if (calls === 2) {
      // An SDK response already queued when cancellation arrives must still be discarded.
      return new Promise((resolve) => request.signal.addEventListener("abort", () => resolve(balance(2)), { once: true }));
    }
    return Promise.resolve(balance(calls));
  } }, "host-pulse");
  const source = createSnapshotSource((value) => value.refreshIntervalMs);
  const load = () => source.load(() => rpc.call("deepseek_balance_snapshot"));
  assert.deepEqual(await load(), balance(1));
  t.mock.timers.tick(10_000);
  const pending = load();
  const rejected = assert.rejects(pending, /timed out/i);
  await flush();
  t.mock.timers.tick(30_000); await rejected;
  assert.deepEqual(source.snapshot(), balance(1));
  t.mock.timers.tick(5000);
  assert.deepEqual(await load(), balance(3));
  await flush();
  assert.deepEqual(source.snapshot(), balance(3));
});

test("successful, failed and invalid responses clear their deadlines", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100_000 });
  const signals = [];
  let outcome = "success";
  const rpc = createHostPulseRpcClient({ callRpc: (request) => {
    signals.push(request.signal);
    if (outcome === "throw") throw new Error("Offline");
    if (outcome === "reject") return Promise.reject(new Error("Offline"));
    return Promise.resolve().then(() => request.outputSchema.parse(outcome === "invalid" ? { status: "ok" } : balance()));
  } }, "host-pulse");
  assert.deepEqual(await rpc.call("deepseek_balance_snapshot"), balance());
  for (outcome of ["throw", "reject", "invalid"]) await assert.rejects(rpc.call("deepseek_balance_snapshot"));
  assert.ok(signals.every((signal) => signal instanceof AbortSignal && !signal.aborted));
  t.mock.timers.tick(60_000); await flush();
  assert.ok(signals.every((signal) => !signal.aborted), "completed requests must not retain a deadline callback");
});

test("monitor reconciliation times out without starting an autonomous retry loop", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100_000 });
  const status = { enabled: true, notifications: true, cursor: 0, active: [], recent: [] };
  let calls = 0;
  const rpc = createHostPulseRpcClient({ callRpc: (request) => {
    calls++;
    if (calls > 1) return Promise.resolve(request.outputSchema.parse(status));
    return new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }));
  } }, "host-pulse");
  const pending = rpc.call("monitor_status");
  const rejected = assert.rejects(pending, /timed out/i);
  t.mock.timers.tick(30_000); await rejected;
  t.mock.timers.tick(300_000); await flush();
  assert.equal(calls, 1);
  assert.deepEqual(await rpc.call("monitor_status"), status);
});
