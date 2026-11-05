import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateDiskIo, parseDiskCounters, rootBlockId } from "../lib/disk-io.ts";
import { parseProcessRows, parseProcessTicks, parseSystemCpuTicks, selectCpuLeader, selectMemoryLeader } from "../lib/process-metrics.ts";

test("disk counters select completed operations, sectors and unweighted busy time", () => {
  assert.deepEqual(parseDiskCounters("vda", "100 50 200 900 300 40 400 1000 2 500 9999 0 0 0 0 90 200"), {
    device: "vda", reads: 100, writes: 300, readSectors: 200, writeSectors: 400, busyMs: 500,
  });
  for (const input of ["", "1 2 3", "100 0 NaN 0 300 0 400 0 0 500 0", "-1 0 0 0 0 0 0 0 0 0 0"]) assert.equal(parseDiskCounters("vda", input), null);
});

test("disk rates use actual elapsed time and 512-byte sectors", () => {
  const before = { device: "vda", reads: 10, writes: 20, readSectors: 100, writeSectors: 200, busyMs: 1000 };
  const now = { device: "vda", reads: 20, writes: 40, readSectors: 200, writeSectors: 400, busyMs: 2000 };
  assert.deepEqual(calculateDiskIo(before, now, 5000), { device: "vda", busyPercent: 20, readIops: 2, writeIops: 4, readBytesPerSecond: 10240, writeBytesPerSecond: 20480 });
  assert.equal(calculateDiskIo(before, before, 5000).busyPercent, 0);
  assert.equal(calculateDiskIo(before, { ...now, busyMs: 9000 }, 5000).busyPercent, 100);
});

test("disk warmup, reset and device changes show unavailable rates instead of fabricated spikes", () => {
  const c = { device: "vda", reads: 10, writes: 20, readSectors: 100, writeSectors: 200, busyMs: 1000 };
  for (const [before, next, elapsed] of [[null, c, 5000], [c, c, null], [c, c, 0], [c, c, -1], [c, c, NaN], [c, { ...c, device: "vdb" }, 5000], [c, { ...c, reads: 0 }, 5000], [c, { ...c, busyMs: 0 }, 5000]]) {
    const result = calculateDiskIo(before, next, elapsed);
    assert.equal(result.busyPercent, null);
    assert.equal(result.readIops, null);
    assert.equal(result.writeBytesPerSecond, null);
  }
});

test("the root block device is chosen by mount point, not first disk or another mount", () => {
  const mounts = "21 1 8:1 / /boot rw - ext4 /dev/sda1 rw\n30 1 253:2 / / rw,relatime - ext4 /dev/vda2 rw\n40 1 8:2 / /data rw - ext4 /dev/sda2 rw";
  assert.equal(rootBlockId(mounts), "253:2");
  assert.equal(rootBlockId("21 1 invalid / / rw - overlay overlay rw"), null);
  assert.equal(rootBlockId(""), null);
});

test("top memory is selected from all processes, including one outside the top six CPU entries", () => {
  const source = [...Array.from({ length: 9 }, (_, i) => `${i + 1} ${100 - i} 1 100 S busy-${i}`), "99 0.0 50.0 1000000 S memory holder"].join("\n");
  const rows = parseProcessRows(source);
  assert.deepEqual(selectMemoryLeader(rows), { pid: 99, name: "memory holder", rssBytes: 1024000000 });
  assert.equal(selectMemoryLeader([]), null);
});

function procStat({ pid = 42, name = "a ) ( spaced process", user = 50, system = 25, start = 1234 } = {}) {
  const fields = Array(22).fill("0");
  fields[0] = "S"; fields[11] = String(user); fields[12] = String(system); fields[19] = String(start);
  return `${pid} (${name}) ${fields.join(" ")}`;
}

test("process ticks tolerate parentheses in names and include only own user/system time", () => {
  assert.deepEqual(parseProcessTicks(procStat()), { pid: 42, startTime: 1234, ticks: 75 });
  for (const input of ["", "42 broken", "42 (short) S", procStat({ user: -1 }), procStat({ user: NaN }), procStat({ start: Infinity })]) assert.equal(parseProcessTicks(input), null);
});

test("aggregate CPU ticks exclude the duplicated guest counters", () => {
  assert.equal(parseSystemCpuTicks("cpu 100 10 20 300 40 50 60 70 80 90\ncpu0 1 2 3"), 650);
  assert.equal(parseSystemCpuTicks("cpu0 1 2 3 4 5 6 7 8"), null);
  assert.equal(parseSystemCpuTicks("cpu 1 2 NaN 4 5 6 7 8"), null);
});

const rows = parseProcessRows("1 99 1 100 S formerly-busy\n2 1 1 200 S busy-now");
const sample = (totalTicks, one, two, coreCount = 16) => ({ totalTicks, coreCount, processes: new Map([[1, { pid: 1, startTime: 10, ticks: one }], [2, { pid: 2, startTime: 20, ticks: two }]]) });

test("CPU leader uses the most recent interval, normalized to all cores, not lifetime ps percentages", () => {
  const before = sample(10000, 2000, 10);
  const current = sample(18000, 2010, 510);
  assert.deepEqual(selectCpuLeader(before, current, rows), { pid: 2, name: "busy-now", cpuPercent: 6.25 });
});

test("CPU warmup, clock reset and changed core counts require a new baseline", () => {
  const before = sample(10000, 2000, 10);
  for (const [previous, current] of [[null, before], [before, before], [before, sample(9000, 2001, 11)], [before, sample(18000, 2010, 510, 8)]]) assert.equal(selectCpuLeader(previous, current, rows), null);
});

test("PID reuse, unreadable/new processes and reset counters cannot win with stale CPU deltas", () => {
  const before = sample(10000, 2000, 10);
  const now = sample(18000, 2010, 8000);
  now.processes.get(2).startTime = 999;
  assert.equal(selectCpuLeader(before, now, rows).pid, 1);
  now.processes.delete(1);
  assert.equal(selectCpuLeader(before, now, rows), null);
  now.processes.get(2).startTime = 20;
  now.processes.get(2).ticks = 1;
  assert.equal(selectCpuLeader(before, now, rows), null);
  now.processes.get(2).ticks = 100;
  before.processes.delete(2);
  assert.equal(selectCpuLeader(before, now, rows), null);
});
