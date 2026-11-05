import { test } from "node:test";
import assert from "node:assert/strict";
import { clampMonitorPosition, createMonitorPreferences, MONITOR_STORAGE_KEY, parseMonitorPreferences } from "../lib/floating-monitor-state.ts";

const defaults = { version: 1, visible: false, position: null };
test("renaming imports Beacon preferences once and keeps later Host Pulse choices", () => {
  const legacy = { version: 1, visible: true, position: { x: 150, y: 72 } };
  const values = new Map([["beacon-floating-monitor-v1", JSON.stringify(legacy)]]);
  const storage = () => ({ getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) });
  const first = createMonitorPreferences(storage);
  assert.deepEqual(first.getSnapshot(), legacy);
  assert.deepEqual(JSON.parse(values.get(MONITOR_STORAGE_KEY)), legacy);
  first.setVisible(false);
  values.set("beacon-floating-monitor-v1", JSON.stringify({ ...legacy, position: { x: 900, y: 900 } }));
  assert.deepEqual(createMonitorPreferences(storage).getSnapshot(), { ...legacy, visible: false });
  values.set(MONITOR_STORAGE_KEY, "corrupt");
  assert.deepEqual(createMonitorPreferences(storage).getSnapshot(), defaults);
});

test("renaming retains imported preferences when storage can be read but not written", () => {
  const legacy = { version: 1, visible: true, position: { x: 150, y: 72 } };
  const store = createMonitorPreferences(() => ({
    getItem: key => key === "beacon-floating-monitor-v1" ? JSON.stringify(legacy) : null,
    setItem: () => { throw new Error("Storage full"); },
  }));
  assert.deepEqual(store.getSnapshot(), legacy);
  store.setPosition({ x: 80, y: 100 });
  assert.deepEqual(store.getSnapshot(), { ...legacy, position: { x: 80, y: 100 } });
});

test("corrupt, oversized and old saved preferences cannot break the monitor", () => {
  for (const raw of [null, "{", "null", "[]", "x".repeat(1025), '{"version":2,"visible":true}', '{"version":1,"visible":"false"}']) {
    assert.deepEqual(parseMonitorPreferences(raw), defaults);
  }
  for (const x of ["1e999", '"20"']) assert.deepEqual(parseMonitorPreferences(`{"version":1,"visible":true,"position":{"x":${x},"y":0}}`), { ...defaults, visible: true });
});

test("pinning, moving, closing and reopening survive a fresh app window", () => {
  const values = new Map();
  const storage = () => ({ getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) });
  const first = createMonitorPreferences(storage);
  assert.deepEqual(first.getSnapshot(), defaults);
  first.setVisible(true);
  first.setPosition({ x: 240, y: 80 });
  const second = createMonitorPreferences(storage);
  assert.deepEqual(second.getSnapshot(), { version: 1, visible: true, position: { x: 240, y: 80 } });
  second.setVisible(false);
  const third = createMonitorPreferences(storage);
  assert.equal(third.getSnapshot().visible, false);
  third.setVisible(true);
  assert.deepEqual(third.getSnapshot().position, { x: 240, y: 80 });
  assert.deepEqual([...values.keys()], [MONITOR_STORAGE_KEY]);
});

test("blocked browser storage still permits pinning and moving in memory", () => {
  const store = createMonitorPreferences(() => { throw new Error("Storage blocked"); });
  store.setVisible(true);
  store.setPosition({ x: 30, y: 40 });
  assert.deepEqual(store.getSnapshot(), { version: 1, visible: true, position: { x: 30, y: 40 } });
});

test("unchanged preferences do not cause render loops and unsubscribed views receive no updates", () => {
  let writes = 0, updates = 0;
  const store = createMonitorPreferences(() => ({ getItem: () => null, setItem: () => writes++ }));
  const unsubscribe = store.subscribe(() => updates++);
  const initial = store.getSnapshot();
  store.setVisible(false);
  assert.equal(store.getSnapshot(), initial);
  store.setPosition({ x: 8, y: 8 });
  store.setPosition({ x: 8, y: 8 });
  assert.equal(writes, 1);
  assert.equal(updates, 1);
  unsubscribe();
  store.setVisible(true);
  assert.equal(updates, 1);
});

test("restoring desktop coordinates on a phone clamps the entire card into view", () => {
  const bounds = { left: 0, top: 0, width: 390, height: 844 };
  const size = { width: 252, height: 132 };
  assert.deepEqual(clampMonitorPosition({ x: 1800, y: 900 }, bounds, size), { x: 130, y: 704 });
  assert.deepEqual(clampMonitorPosition({ x: -80, y: -80 }, bounds, size), { x: 8, y: 8 });
  assert.deepEqual(clampMonitorPosition({ x: 40, y: 60 }, bounds, size), { x: 40, y: 60 });
});

test("zoom offsets and a smaller viewport keep the title reachable", () => {
  const bounds = { left: 20, top: 30, width: 200, height: 100 };
  assert.deepEqual(clampMonitorPosition({ x: 700, y: 900 }, bounds, { width: 252, height: 132 }), { x: 28, y: 38 });
});
