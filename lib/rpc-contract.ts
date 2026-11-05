import { z } from "zod";
import { providerUsageSnapshotSchema } from "./provider-usage.ts";
import { deepseekBalanceSnapshotSchema } from "./deepseek-balance-schema.ts";

const percentageSchema = z.number().min(0).max(100);
const metricPointSchema = z.object({
  timestamp: z.number(),
  cpuPercent: percentageSchema.nullable(),
  memoryPercent: percentageSchema,
  networkRxBytesPerSecond: z.number().nullable(),
  networkTxBytesPerSecond: z.number().nullable(),
});
const issueSchema = z.object({
  severity: z.enum(["warning", "critical"]),
  label: z.string(),
  message: z.string(),
});
const processSchema = z.object({
  pid: z.number().int().positive(),
  name: z.string().max(128),
  cpuPercent: z.number().nonnegative(),
  memoryPercent: z.number().nonnegative(),
  rssBytes: z.number().nonnegative(),
});
const snapshotSchema = z.object({
  timestamp: z.string(),
  refreshIntervalMs: z.number().int().min(2000).max(60_000),
  host: z.object({
    hostname: z.string(),
    platform: z.string(),
    release: z.string(),
    arch: z.string(),
    uptimeSeconds: z.number(),
  }),
  cpu: z.object({
    model: z.string(),
    cores: z.number().int().positive(),
    speedMHz: z.number().nonnegative(),
    usagePercent: percentageSchema.nullable(),
    perCoreUsagePercent: z.array(percentageSchema.nullable()),
    loadAverage: z.tuple([z.number(), z.number(), z.number()]),
  }),
  memory: z.object({
    totalBytes: z.number(),
    usedBytes: z.number(),
    freeBytes: z.number(),
    availableBytes: z.number(),
    cachedBytes: z.number(),
    buffersBytes: z.number(),
    swapTotalBytes: z.number(),
    swapUsedBytes: z.number(),
    usagePercent: percentageSchema,
  }),
  disk: z.object({
    mount: z.string(),
    totalBytes: z.number(),
    usedBytes: z.number(),
    freeBytes: z.number(),
    usagePercent: percentageSchema,
  }).nullable(),
  diskIo: z.object({
    device: z.string(),
    busyPercent: percentageSchema.nullable(),
    readIops: z.number().nonnegative().nullable(),
    writeIops: z.number().nonnegative().nullable(),
    readBytesPerSecond: z.number().nonnegative().nullable(),
    writeBytesPerSecond: z.number().nonnegative().nullable(),
  }).nullable(),
  network: z.object({
    interface: z.string(),
    rxBytesPerSecond: z.number().nullable(),
    txBytesPerSecond: z.number().nullable(),
    rxTotalBytes: z.number(),
    txTotalBytes: z.number(),
  }).nullable(),
  processes: z.object({
    available: z.boolean(),
    total: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    top: z.array(processSchema).max(6),
    topCpu: z.object({ pid: z.number().int().positive(), name: z.string().max(128), cpuPercent: percentageSchema }).nullable(),
    topMemory: z.object({ pid: z.number().int().positive(), name: z.string().max(128), rssBytes: z.number().nonnegative() }).nullable(),
  }),
  runtime: z.object({
    pid: z.number().int().positive(),
    nodeVersion: z.string(),
    processUptimeSeconds: z.number(),
    rssBytes: z.number(),
    heapUsedBytes: z.number(),
    heapTotalBytes: z.number(),
    externalBytes: z.number(),
  }),
  health: z.object({
    status: z.enum(["healthy", "warning", "critical"]),
    issues: z.array(issueSchema),
  }),
  history: z.array(metricPointSchema).max(72),
});

export type ServerSnapshot = z.infer<typeof snapshotSchema>;

export const hostPulseRpcContract = {
  deepseek_balance_snapshot: { input: z.null(), output: deepseekBalanceSnapshotSchema },
  provider_usage_snapshot: { input: z.null(), output: providerUsageSnapshotSchema },
  metrics_snapshot: { input: z.null(), output: snapshotSchema },
  metrics_refresh: { input: z.null(), output: snapshotSchema },
  monitor_status: { input: z.null(), output: z.object({ enabled: z.boolean(), notifications: z.boolean(), cursor: z.number(), active: z.array(z.object({ sequence: z.number(), type: z.enum(["incident", "recovery"]), metric: z.enum(["cpu", "memory"]), timestamp: z.number(), value: z.number(), peak: z.number(), durationSeconds: z.number(), threshold: z.number() })).max(2), recent: z.array(z.object({ sequence: z.number(), type: z.enum(["incident", "recovery"]), metric: z.enum(["cpu", "memory"]), timestamp: z.number(), value: z.number(), peak: z.number(), durationSeconds: z.number(), threshold: z.number() })).max(32) }) },
};
