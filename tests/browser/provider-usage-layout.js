// Run against an isolated BB Browser Automation session with Host Pulse installed:
// bb browser-automation run <session> --script-file tests/browser/provider-usage-layout.js --script-host <host-id> --timeout-ms 25000
const page = await browser.getPage("main");
const future = new Date(Date.now() + (29 * 24 + 23) * 3_600_000).toISOString();
const window = (label, usedPercent, resetsAt = future) => ({ label, usedPercent, resetsAt, cost: null });
const provider = (id, label, windows, accountLabel = null) => ({ id, label, windows, accountLabel, planLabel: null, status: "ok" });
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
const balance = { status: "ok", checkedAt: Date.now(), refreshIntervalMs: 10_000, isAvailable: true, balances: [
  { currency: "USD", total_balance: "123.45", topped_up_balance: "123.45", granted_balance: "0" },
  { currency: "CNY", total_balance: "789.01", topped_up_balance: "789.01", granted_balance: "0" },
] };
const standardProviders = [
  provider("codex", "Codex", [window("Weekly limit", 39)]),
  provider("claude", "Claude Code", [window("Five-hour limit", 0, null), window("Weekly limit", 83)]),
  provider("opencode", "opencode", [window("Five-hour limit", 12.5), window("Weekly limit", 99.9), window("Monthly", 100)]),
];
let providers = standardProviders;
const fixture = request => {
  const data = request.url().includes("/plugins/host-pulse/rpc/metrics_snapshot") ? metrics
    : request.url().includes("/plugins/host-pulse/rpc/deepseek_balance_snapshot") ? balance : null;
  if (data) {
    void request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, result: data }) }).catch(() => {});
    return;
  }
  if (!request.url().includes("/plugins/host-pulse/rpc/provider_usage_snapshot")) {
    void request.continue().catch(() => {});
    return;
  }
  void request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, result: {
    status: "ok", checkedAt: Date.now(), groupLabel: "Layout regression fixtures", refreshIntervalMs: 60_000, providers,
  } }) }).catch(() => {});
};
await page.setRequestInterception(true);
page.on("request", fixture);
const script = await page.evaluateOnNewDocument(() => {
  localStorage.setItem("host-pulse-floating-monitor-v1", JSON.stringify({ version: 1, visible: true, position: { x: 8, y: 8 } }));
});

async function inspect({ width, scale = 1, compact = false, touch = false }) {
  await page.setViewport({ width, height: 900, isMobile: touch, hasTouch: touch });
  const report = await page.evaluate(async ({ scale, compact, touch }) => {
    const root = document.querySelector(".host-pulse-float");
    const nodes = [root, ...root.querySelectorAll("*")];
    const styles = nodes.map(node => node.getAttribute("style"));
    const sizes = nodes.map(node => parseFloat(getComputedStyle(node).fontSize) * scale);
    try {
      if (scale !== 1) nodes.forEach((node, i) => { node.style.fontSize = `${sizes[i]}px`; });
      const list = root.querySelector(".host-pulse-float-usage-list");
      list.scrollTop = 0;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const errors = [];
      if (matchMedia("(pointer: coarse)").matches !== touch) errors.push("Unexpected pointer mode");
      const cardBounds = root.getBoundingClientRect();
      for (const button of root.querySelectorAll(".host-pulse-float-header button")) {
        const bounds = button.getBoundingClientRect();
        if (bounds.left < cardBounds.left || bounds.right > cardBounds.right) errors.push("Monitor control clipped");
        if (touch && (bounds.width < 36 || bounds.height < 36)) errors.push("Touch control too small");
      }
      const groups = [...list.children];
      for (let i = 1; i < groups.length; i++) {
        if (groups[i].getBoundingClientRect().top - groups[i - 1].getBoundingClientRect().bottom < 7.9) errors.push("Provider rows are too close");
      }
      const title = document.createRange();
      title.selectNodeContents(root.querySelector(".host-pulse-float-handle span"));
      const titleBounds = title.getBoundingClientRect(), headerBounds = root.querySelector(".host-pulse-float-header").getBoundingClientRect();
      if (titleBounds.top < headerBounds.top - 1 || titleBounds.bottom > headerBounds.bottom + 1) errors.push("Monitor title clipped");
      for (const element of [root, list, ...root.querySelectorAll(".host-pulse-float-usage-windows, .host-pulse-float-quota")]) {
        if (element.scrollWidth > element.clientWidth + 1) errors.push(`Horizontal overflow: ${element.className}`);
      }
      const quotaCount = root.querySelectorAll(".host-pulse-float-quota").length;
      const rows = [...root.querySelectorAll(".host-pulse-float-usage-row")].map(row => {
        const quotas = [...row.querySelectorAll(".host-pulse-float-quota")];
        const bounds = quotas.map(quota => quota.getBoundingClientRect());
        const nameBounds = row.querySelector(".host-pulse-float-usage-name").getBoundingClientRect();
        if (bounds.length) {
          const stacked = bounds[0].top >= nameBounds.bottom - 1;
          if (stacked ? bounds[0].top - nameBounds.bottom < 3.9 : bounds[0].left - nameBounds.right < 7.9) errors.push("Provider name is too close to its quotas");
        }
        for (let i = 1; i < bounds.length; i++) {
          const sameLine = Math.abs(bounds[i].top - bounds[i - 1].top) < 1;
          const gap = sameLine ? bounds[i].left - bounds[i - 1].right : bounds[i].top - bounds[i - 1].bottom;
          if (gap < 7.9) errors.push("Quota cells are too close");
        }
        for (const quota of quotas) {
          const countdown = quota.querySelector(".host-pulse-float-quota-reset");
          if (countdown.getBoundingClientRect().top - quota.querySelector(".host-pulse-float-quota-track").getBoundingClientRect().bottom < 3.9) errors.push("Reset countdown is too close to its bar");
        }
        if (compact && bounds.length) {
          if (new Set(bounds.map(rect => Math.round(rect.top))).size !== 1) errors.push("Quota windows wrapped at normal width");
          if (bounds.some(rect => rect.bottom > list.getBoundingClientRect().bottom + 1)) errors.push("Quota window clipped at normal width");
          if (Math.abs(row.querySelector(".host-pulse-float-usage-name").getBoundingClientRect().top - bounds[0].top) > 2) errors.push("Provider name detached from first quota line");
          for (const quota of quotas) {
            const heading = quota.firstElementChild;
            const label = heading.firstElementChild.getBoundingClientRect(), value = heading.lastElementChild.getBoundingClientRect();
            if (Math.abs(label.top - value.top) > 2 || value.left - label.right < 5.9) errors.push("Quota label and percentage are crowded or wrapped");
          }
        }
        return { name: row.querySelector(".host-pulse-float-usage-name").textContent, windows: quotas.length };
      });
      // Inspect actual text rectangles, including content revealed by scrolling.
      const scrollPositions = Array.from({ length: Math.ceil(list.scrollHeight / list.clientHeight) + 1 }, (_, i) => i * list.clientHeight);
      for (const scroll of scrollPositions) {
        list.scrollTop = scroll;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const textRects = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (!node.textContent.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const bounds of range.getClientRects()) {
            const rect = { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom };
            for (let element = node.parentElement; element; element = element.parentElement) {
              const style = getComputedStyle(element), clip = element.getBoundingClientRect();
              if (/hidden|clip|auto|scroll/.test(style.overflowX)) { rect.left = Math.max(rect.left, clip.left); rect.right = Math.min(rect.right, clip.right); }
              if (/hidden|clip|auto|scroll/.test(style.overflowY)) { rect.top = Math.max(rect.top, clip.top); rect.bottom = Math.min(rect.bottom, clip.bottom); }
            }
            if (rect.right > rect.left && rect.bottom > rect.top) textRects.push({ node, rect });
          }
        }
        for (let i = 0; i < textRects.length; i++) for (let j = i + 1; j < textRects.length; j++) {
          const a = textRects[i], b = textRects[j];
          if (a.node === b.node) continue;
          if (Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left) > 0.1 &&
              Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top) > 0.1) errors.push("Visible text overlaps");
        }
      }
      const lastQuota = [...root.querySelectorAll(".host-pulse-float-quota")].at(-1);
      if (lastQuota && lastQuota.getBoundingClientRect().bottom > list.getBoundingClientRect().bottom + 1) errors.push("Last quota cannot be reached by scrolling");
      return { width: innerWidth, scale, compact, touch, rows, quotaCount, listHeight: list.clientHeight, errors };
    } finally {
      nodes.forEach((node, i) => { if (styles[i] === null) node.removeAttribute("style"); else node.setAttribute("style", styles[i]); });
    }
  }, { scale, compact, touch });
  console.log(JSON.stringify(report));
  if (report.errors.length) throw new Error(report.errors.join("; "));
}

try {
  await page.setViewport({ width: 1280, height: 900, isMobile: false, hasTouch: false });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll(".host-pulse-float-quota").length === 6 &&
    document.querySelector(".host-pulse-float-metric strong")?.textContent === "100%" &&
    document.querySelector(".host-pulse-float-balance-value")?.textContent.includes("789.01"), { timeout: 10_000 });
  for (const width of [1280, 390, 220, 180, 390]) await inspect({ width, compact: width >= 390 });
  for (const scale of [1.25, 1.5]) for (const width of [390, 220, 180]) await inspect({ width, scale });
  providers = [
    provider("a", "Codex", [window("Weekly limit", 100.1), window("Daily limit", 0, null), window("Monthly", 124), window("Extra model with a long quota label", 25)], "first-long-account-label@example.test"),
    provider("b", "Codex", [window("Five-hour limit", 100), window("Weekly limit", 22)], "second@example.test"),
    provider("c", "Claude Code", [], null),
  ];
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector(".host-pulse-float-usage")?.textContent.includes("second@example.test"), { timeout: 10_000 });
  for (const width of [390, 220, 180]) await inspect({ width });
  for (const scale of [1.25, 1.5]) for (const width of [390, 220, 180]) await inspect({ width, scale });
  // Coarse pointers reserve larger buttons. That can crowd the title/status even
  // when the same viewport passes with a mouse, especially with enlarged text.
  providers = standardProviders;
  await page.setViewport({ width: 390, height: 900, isMobile: true, hasTouch: true });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector(".host-pulse-float-usage")?.textContent.includes("opencode") &&
    document.querySelectorAll(".host-pulse-float-quota").length === 6, { timeout: 10_000 });
  for (const width of [390, 320, 220, 190, 180, 390]) await inspect({ width, touch: true, compact: width >= 320 });
  for (const scale of [1.25, 1.5]) for (const width of [390, 320, 220, 190, 180]) await inspect({ width, scale, touch: true });
} finally {
  await page.setRequestInterception(false);
  page.off("request", fixture);
  await page.removeScriptToEvaluateOnNewDocument(script.identifier);
  await page.setViewport({ width: 1280, height: 900, isMobile: false, hasTouch: false });
  await page.reload({ waitUntil: "domcontentloaded" });
}
