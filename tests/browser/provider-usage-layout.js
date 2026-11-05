// Run against an isolated BB Browser Automation session with Host Pulse installed:
// bb browser-automation run <session> --script-file tests/browser/provider-usage-layout.js --timeout-ms 25000
const page = await browser.getPage("main");
const future = new Date(Date.now() + (29 * 24 + 23) * 3_600_000).toISOString();
const window = (label, usedPercent, resetsAt = future) => ({ label, usedPercent, resetsAt, cost: null });
const provider = (id, label, windows, accountLabel = null) => ({ id, label, windows, accountLabel, planLabel: null, status: "ok" });
let providers = [
  provider("codex", "Codex", [window("Weekly limit", 39)]),
  provider("claude", "Claude Code", [window("Five-hour limit", 0, null), window("Weekly limit", 83)]),
  provider("opencode", "opencode", [window("Five-hour limit", 12.5), window("Weekly limit", 99.9), window("Monthly", 100)]),
];
const fixture = request => {
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

async function inspect({ width, scale = 1, compact = false }) {
  await page.setViewport({ width, height: 900 });
  const report = await page.evaluate(async ({ scale, compact }) => {
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
      for (const element of [root, list, ...root.querySelectorAll(".host-pulse-float-usage-windows, .host-pulse-float-quota")]) {
        if (element.scrollWidth > element.clientWidth + 1) errors.push(`Horizontal overflow: ${element.className}`);
      }
      const quotaCount = root.querySelectorAll(".host-pulse-float-quota").length;
      const rows = [...root.querySelectorAll(".host-pulse-float-usage-row")].map(row => {
        const quotas = [...row.querySelectorAll(".host-pulse-float-quota")];
        const bounds = quotas.map(quota => quota.getBoundingClientRect());
        if (compact && bounds.length) {
          if (new Set(bounds.map(rect => Math.round(rect.top))).size !== 1) errors.push("Quota windows wrapped at normal width");
          if (bounds.some(rect => rect.bottom > list.getBoundingClientRect().bottom + 1)) errors.push("Quota window clipped at normal width");
          if (Math.abs(row.querySelector(".host-pulse-float-usage-name").getBoundingClientRect().top - bounds[0].top) > 2) errors.push("Provider name detached from first quota line");
        }
        return { name: row.querySelector(".host-pulse-float-usage-name").textContent, windows: quotas.length };
      });
      // Inspect actual text rectangles, including content revealed by scrolling.
      for (const scroll of [0, list.scrollHeight]) {
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
      return { width: innerWidth, scale, compact, rows, quotaCount, listHeight: list.clientHeight, errors };
    } finally {
      nodes.forEach((node, i) => { if (styles[i] === null) node.removeAttribute("style"); else node.setAttribute("style", styles[i]); });
    }
  }, { scale, compact });
  console.log(JSON.stringify(report));
  if (report.errors.length) throw new Error(report.errors.join("; "));
}

try {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll(".host-pulse-float-quota").length === 6, { timeout: 10_000 });
  for (const width of [1280, 390, 220, 180]) await inspect({ width, compact: width >= 390 });
  for (const width of [390, 220]) await inspect({ width, scale: 1.25 });
  providers = [
    provider("a", "Codex", [window("Weekly limit", 100.1), window("Daily limit", 0, null), window("Monthly", 124), window("Extra model with a long quota label", 25)], "first-long-account-label@example.test"),
    provider("b", "Codex", [window("Five-hour limit", 100), window("Weekly limit", 22)], "second@example.test"),
    provider("c", "Claude Code", [], null),
  ];
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector(".host-pulse-float-usage")?.textContent.includes("second@example.test"), { timeout: 10_000 });
  for (const width of [390, 220, 180]) await inspect({ width });
  await inspect({ width: 390, scale: 1.25 });
} finally {
  await page.setRequestInterception(false);
  page.off("request", fixture);
  await page.removeScriptToEvaluateOnNewDocument(script.identifier);
  await page.setViewport({ width: 1280, height: 900 });
  await page.reload({ waitUntil: "domcontentloaded" });
}
