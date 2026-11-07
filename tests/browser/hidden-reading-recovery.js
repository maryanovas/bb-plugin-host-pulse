// Run in an isolated BB Browser Automation session on a BB page with Host Pulse.
// A successful response received while hidden must remain the displayed last
// reading if the next attempt fails. Exercise all three real frontend hooks.
const p = await browser.getPage("main");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const metrics = {
  timestamp: new Date().toISOString(), refreshIntervalMs: 5000,
  host: { hostname: "layout-test", platform: "linux", release: "test", arch: "x64", uptimeSeconds: 1000 },
  cpu: { model: "Test CPU", cores: 16, speedMHz: 3000, usagePercent: 100, perCoreUsagePercent: Array(16).fill(100), loadAverage: [16, 16, 16] },
  memory: { totalBytes: 32 * 1024 ** 3, usedBytes: 32 * 1024 ** 3, freeBytes: 0, availableBytes: 0, cachedBytes: 0, buffersBytes: 0, swapTotalBytes: 0, swapUsedBytes: 0, usagePercent: 100 },
  disk: { mount: "/", totalBytes: 1024 ** 4, usedBytes: 1024 ** 4, freeBytes: 0, usagePercent: 100 }, diskIo: null,
  network: { interface: "test0", rxBytesPerSecond: 1023.9 * 1024 ** 2, txBytesPerSecond: 1023.9 * 1024 ** 2, rxTotalBytes: 1024 ** 4, txTotalBytes: 1024 ** 4 },
  processes: { available: true, total: 100, running: 16, top: [],
    topCpu: { pid: 4194303, name: "long-process-name-for-layout", cpuPercent: 100 },
    topMemory: { pid: 4194303, name: "long-memory-process-name", rssBytes: 31.99 * 1024 ** 3 },
  },
  runtime: { pid: 123, nodeVersion: "v26.0.0", processUptimeSeconds: 1000, rssBytes: 1024 ** 3, heapUsedBytes: 1024 ** 2, heapTotalBytes: 2 * 1024 ** 2, externalBytes: 0 },
  health: { status: "critical", issues: [] }, history: [],
};

const key = "host-pulse-floating-monitor-v1";
const saved = await p.evaluate(key => localStorage.getItem(key), key);
const methods = ["metrics_snapshot", "provider_usage_snapshot", "deepseek_balance_snapshot"];
const calls = Object.fromEntries(methods.map(method => [method, 0]));
const held = new Map();
const failed = new Map();
function reading(method, value) {
  if (method === "metrics_snapshot") return {
    ...metrics, timestamp: new Date().toISOString(), refreshIntervalMs: 2000,
    cpu: { ...metrics.cpu, usagePercent: value * 10 },
  };
  if (method === "provider_usage_snapshot") return {
    status: "ok", checkedAt: Date.now(), refreshIntervalMs: 60_000, groupLabel: "Regression fixture",
    providers: [{ id: "test", label: "Codex", accountLabel: null, planLabel: null, status: "ok",
      windows: [{ label: "Weekly limit", usedPercent: value * 10, resetsAt: null, cost: null }],
    }],
  };
  return { status: "ok", checkedAt: Date.now(), refreshIntervalMs: 10_000, isAvailable: true,
    balances: [{ currency: "USD", total_balance: `${value}.00`, topped_up_balance: `${value}.00`, granted_balance: "0" }],
  };
}
const respond = (request, result) => request.respond({
  status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, result }),
});
const handler = request => {
  const method = request.url().match(/\/plugins\/host-pulse\/rpc\/([a-z_]+)/)?.[1];
  if (!methods.includes(method)) { void request.continue().catch(() => {}); return; }
  const count = ++calls[method];
  if (count === 2) { held.set(method, request); return; }
  if (count >= 3) {
    failed.set(method, request);
    return;
  }
  void respond(request, reading(method, count)).catch(() => {});
};
async function visibility(hidden) {
  await p.evaluate(hidden => {
    if (hidden) Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    else delete document.visibilityState;
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
  // Let React commit active=false and dispose provider/balance pollers before resuming.
  await pause(100);
}
await p.setViewport({ width: 1280, height: 900, isMobile: false, hasTouch: false });
await p.setRequestInterception(true); p.on("request", handler);
try {
  await p.evaluate(key => localStorage.setItem(key, JSON.stringify({ version: 1, visible: true, position: { x: 450, y: 100 } })), key);
  await p.reload({ waitUntil: "domcontentloaded" });
  await p.waitForFunction(() =>
    document.querySelector(".host-pulse-float-metric strong")?.textContent === "10%" &&
    document.querySelector(".host-pulse-float-quota strong")?.textContent === "10%" &&
    document.querySelector(".host-pulse-float-balance-value")?.textContent === "$1.00",
  { timeout: 10_000 });
  // Advance only the test browser's wall clock while polling is paused. This
  // expires even the minute quota cache without changing production intervals.
  await p.evaluate(() => {
    const original = Date.now;
    window.__hostPulseTestClock = { offset: 0, restore: () => { Date.now = original; delete window.__hostPulseTestClock; } };
    Date.now = () => original() + window.__hostPulseTestClock.offset;
  });
  await visibility(true);
  await p.evaluate(() => { window.__hostPulseTestClock.offset += 61_000; });
  await visibility(false);
  const deadline = Date.now() + 4000;
  while (held.size < methods.length && Date.now() < deadline) await pause(25);
  if (held.size !== methods.length) throw new Error("Not all three refreshes started: " + JSON.stringify(calls));
  await visibility(true);
  await Promise.all([...held].map(([method, request]) => respond(request, reading(method, 2))));
  held.clear();
  await pause(300);
  if (!methods.every(method => calls[method] === 2)) throw new Error("A hidden tab started another request");
  await p.evaluate(() => { window.__hostPulseTestClock.offset += 61_000; });
  await visibility(false);
  const failureDeadline = Date.now() + 4000;
  while (failed.size < methods.length && Date.now() < failureDeadline) await pause(25);
  if (failed.size !== methods.length) throw new Error("Not all three resumed requests started");
  await pause(100);
  const pendingValues = await p.evaluate(() => ({
    cpu: document.querySelector(".host-pulse-float-metric strong")?.textContent,
    quota: document.querySelector(".host-pulse-float-quota strong")?.textContent,
    balance: document.querySelector(".host-pulse-float-balance-value")?.textContent,
  }));
  await Promise.all([...failed.values()].map(request => request.respond({
    status: 503, contentType: "application/json",
    body: JSON.stringify({ ok: false, error: { code: "unavailable", message: "Temporary test failure" } }),
  })));
  failed.clear();
  await p.waitForFunction(() =>
    document.querySelector(".host-pulse-float-status")?.textContent === "Retrying" &&
    !!document.querySelector(".host-pulse-float-usage-status") &&
    document.querySelector(".host-pulse-float-balance-note")?.textContent === "stale",
  { timeout: 4000 });
  const result = await p.evaluate(() => ({
    cpu: document.querySelector(".host-pulse-float-metric strong")?.textContent,
    quota: document.querySelector(".host-pulse-float-quota strong")?.textContent,
    balance: document.querySelector(".host-pulse-float-balance-value")?.textContent,
    status: document.querySelector(".host-pulse-float-status")?.textContent,
    quotaWarning: document.querySelector(".host-pulse-float-usage-status")?.textContent,
    balanceWarning: document.querySelector(".host-pulse-float-balance-note")?.textContent,
  }));
  console.log(JSON.stringify({ calls, pendingValues, ...result }));
  if ([pendingValues, result].some(value => value.cpu !== "20%" || value.quota !== "20%" || value.balance !== "$2.00")) {
    throw new Error("A newer successful hidden reading was lost when the next request failed");
  }
} finally {
  for (const request of held.values()) await request.abort().catch(() => {});
  for (const request of failed.values()) await request.abort().catch(() => {});
  await p.setRequestInterception(false); p.off("request", handler);
  await p.evaluate(({ key, saved }) => {
    delete document.visibilityState; window.__hostPulseTestClock?.restore();
    if (saved === null) localStorage.removeItem(key); else localStorage.setItem(key, saved);
  }, { key, saved });
  await p.reload({ waitUntil: "domcontentloaded" });
}
