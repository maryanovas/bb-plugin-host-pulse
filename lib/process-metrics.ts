import { readFile } from "node:fs/promises";

export interface ProcessRow {
  pid: number;
  name: string;
  cpuPercent: number;
  memoryPercent: number;
  rssBytes: number;
  running: boolean;
}
export interface ProcessTicks { pid: number; startTime: number; ticks: number }
export interface ProcessCpuSnapshot { totalTicks: number; coreCount: number; processes: Map<number, ProcessTicks> }
export interface CpuLeader { pid: number; name: string; cpuPercent: number }

export function parseProcessRows(source: string): ProcessRow[] {
  return source.split("\n").flatMap((line) => {
    // comm comes last; never read command lines or environments.
    const match = /^\s*(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match || match[6] === "ps") return [];
    const [pid, cpuPercent, memoryPercent, rssKiB] = match.slice(1, 5).map(Number);
    if (!Number.isSafeInteger(pid) || pid <= 0 || ![cpuPercent, memoryPercent, rssKiB * 1024].every(Number.isFinite)) return [];
    return [{ pid, name: match[6].slice(0, 128), cpuPercent, memoryPercent, rssBytes: rssKiB * 1024, running: match[5].startsWith("R") }];
  });
}

export function selectMemoryLeader(rows: ProcessRow[]) {
  const winner = rows.reduce<ProcessRow | null>((best, row) => !best || row.rssBytes > best.rssBytes || (row.rssBytes === best.rssBytes && row.pid < best.pid) ? row : best, null);
  return winner ? { pid: winner.pid, name: winner.name, rssBytes: winner.rssBytes } : null;
}

// Parentheses and spaces may occur inside comm; its closing ')' is the last one.
export function parseProcessTicks(source: string): ProcessTicks | null {
  const open = source.indexOf("(");
  const close = source.lastIndexOf(")");
  if (open < 1 || close <= open) return null;
  const pid = Number(source.slice(0, open).trim());
  const fields = source.slice(close + 1).trim().split(/\s+/); // Starts at field 3 (state).
  if (fields.length < 22 || fields[0].length !== 1) return null;
  const user = Number(fields[11]), system = Number(fields[12]), startTime = Number(fields[19]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || ![user, system, startTime, user + system].every((value) => Number.isSafeInteger(value) && value >= 0)) return null;
  return { pid, startTime, ticks: user + system };
}

export function parseSystemCpuTicks(source: string): number | null {
  const fields = source.split("\n", 1)[0].trim().split(/\s+/);
  if (fields[0] !== "cpu" || fields.length < 9) return null;
  // guest and guest_nice are already included in user/nice; do not count them twice.
  const counters = fields.slice(1, 9).map(Number);
  if (!counters.every((value) => Number.isSafeInteger(value) && value >= 0)) return null;
  const total = counters.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) ? total : null;
}

/** Percent of the whole host (100% = all cores), measured between consecutive scans. */
export function selectCpuLeader(previous: ProcessCpuSnapshot | null, current: ProcessCpuSnapshot, rows: ProcessRow[]): CpuLeader | null {
  if (!previous || previous.coreCount !== current.coreCount || current.totalTicks <= previous.totalTicks) return null;
  const totalDelta = current.totalTicks - previous.totalTicks;
  let best: CpuLeader | null = null;
  for (const row of rows) {
    const before = previous.processes.get(row.pid), now = current.processes.get(row.pid);
    // PID reuse, a newly started process or a missed scan needs a fresh baseline.
    if (!before || !now || before.startTime !== now.startTime || now.ticks < before.ticks) continue;
    const cpuPercent = Math.min(100, Math.max(0, (now.ticks - before.ticks) / totalDelta * 100));
    if (!best || cpuPercent > best.cpuPercent || (cpuPercent === best.cpuPercent && row.pid < best.pid)) best = { pid: row.pid, name: row.name, cpuPercent };
  }
  return best;
}

export function createProcessCpuSampler() {
  let previous: ProcessCpuSnapshot | null = null;
  return {
    async sample(rows: ProcessRow[], coreCount: number, signal: AbortSignal): Promise<CpuLeader | null> {
      try {
        // Bound both the scan and retained baselines. The ps result is independently capped.
        if (rows.length > 10_000) { previous = null; return null; }
        const scanSignal = AbortSignal.any([signal, AbortSignal.timeout(1500)]);
        const totalTicks = parseSystemCpuTicks(await readFile("/proc/stat", { encoding: "utf8", signal: scanSignal }));
        if (totalTicks === null) { previous = null; return null; }
        const processes = new Map<number, ProcessTicks>();
        let index = 0;
        await Promise.all(Array.from({ length: Math.min(16, rows.length) }, async () => {
          while (index < rows.length) {
            scanSignal.throwIfAborted();
            const row = rows[index++];
            try {
              const ticks = parseProcessTicks(await readFile(`/proc/${row.pid}/stat`, { encoding: "utf8", signal: scanSignal }));
              if (ticks?.pid === row.pid) processes.set(row.pid, ticks);
            } catch { /* Exited or unreadable process; skip it, never invent zero usage. */ }
          }
        }));
        scanSignal.throwIfAborted();
        const current = { totalTicks, coreCount, processes };
        const leader = selectCpuLeader(previous, current, rows);
        previous = current;
        return leader;
      } catch { previous = null; return null; }
    },
    reset() { previous = null; },
  };
}
