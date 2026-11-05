import { readFile, realpath, access } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { platform } from "node:os";

export interface DiskCounters {
  device: string;
  reads: number;
  writes: number;
  readSectors: number;
  writeSectors: number;
  busyMs: number;
}
export interface DiskIo {
  device: string;
  busyPercent: number | null;
  readIops: number | null;
  writeIops: number | null;
  readBytesPerSecond: number | null;
  writeBytesPerSecond: number | null;
}

// Linux block stat fields: https://www.kernel.org/doc/html/latest/admin-guide/iostats.html
export function parseDiskCounters(device: string, source: string): DiskCounters | null {
  const fields = source.trim().split(/\s+/).map(Number);
  if (fields.length < 11 || !fields.slice(0, 11).every((v) => Number.isSafeInteger(v) && v >= 0)) return null;
  return { device, reads: fields[0], readSectors: fields[2], writes: fields[4], writeSectors: fields[6], busyMs: fields[9] };
}

export function calculateDiskIo(previous: DiskCounters | null, current: DiskCounters, elapsedMs: number | null): DiskIo {
  const empty: DiskIo = { device: current.device, busyPercent: null, readIops: null, writeIops: null, readBytesPerSecond: null, writeBytesPerSecond: null };
  const counters = ["reads", "writes", "readSectors", "writeSectors", "busyMs"] as const;
  if (!previous || previous.device !== current.device || elapsedMs === null || !Number.isFinite(elapsedMs) || elapsedMs <= 0 || counters.some((key) => current[key] < previous[key])) return empty;
  const seconds = elapsedMs / 1000;
  return {
    device: current.device,
    busyPercent: Math.min(100, Math.max(0, (current.busyMs - previous.busyMs) / elapsedMs * 100)),
    readIops: (current.reads - previous.reads) / seconds,
    writeIops: (current.writes - previous.writes) / seconds,
    // These counters always use 512-byte sectors, independent of physical sector size.
    readBytesPerSecond: (current.readSectors - previous.readSectors) * 512 / seconds,
    writeBytesPerSecond: (current.writeSectors - previous.writeSectors) * 512 / seconds,
  };
}

export function rootBlockId(mountinfo: string): string | null {
  const fields = mountinfo.split("\n").map((line) => line.split(" ")).find((parts) => parts[4] === "/");
  return fields && /^\d+:\d+$/.test(fields[2]) ? fields[2] : null;
}

async function readRootDiskCounters(signal: AbortSignal): Promise<DiskCounters | null> {
  if (platform() !== "linux") return null;
  const mountinfo = await readFile("/proc/self/mountinfo", { encoding: "utf8", signal });
  const id = rootBlockId(mountinfo);
  if (!id) return null;
  let path = await realpath(`/sys/dev/block/${id}`);
  // Measure the device backing /, not both its partition and parent (double counting).
  // For device-mapper/RAID the mapped device already accounts for its own requests.
  try { await access(join(path, "partition")); path = dirname(path); } catch { /* Whole device. */ }
  const source = await readFile(join(path, "stat"), { encoding: "utf8", signal });
  return parseDiskCounters(basename(path), source);
}

export function createDiskIoSampler() {
  let previous: { counters: DiskCounters; time: number } | null = null;
  return {
    async sample(signal: AbortSignal): Promise<DiskIo | null> {
      try {
        const counters = await readRootDiskCounters(signal);
        signal.throwIfAborted();
        if (!counters) { previous = null; return null; }
        const time = performance.now();
        const result = calculateDiskIo(previous?.counters ?? null, counters, previous ? time - previous.time : null);
        previous = { counters, time };
        return result;
      } catch { previous = null; return null; }
    },
    reset() { previous = null; },
  };
}
