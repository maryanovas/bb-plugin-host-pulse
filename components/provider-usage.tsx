import { useEffect, useState } from "react";
import { useProviderUsage } from "../hooks/use-provider-usage";
import type { ProviderUsageSnapshot } from "../lib/provider-usage";
import { quotaResetCountdown } from "../lib/quota-reset";

type UsageWindow = ProviderUsageSnapshot["providers"][number]["windows"][number];

function windowLabel(label: string) {
  return label.replace(/^five-hour limit\b/i, "5h").replace(/^weekly(?: limit)?\b/i, "7d").replace(/^daily limit\b/i, "24h");
}
function quotaTitle(window: UsageWindow, countdown: string) {
  const reset = window.resetsAt ? new Date(window.resetsAt) : null;
  return [window.label, `${window.usedPercent}% used`, countdown,
    reset && Number.isFinite(reset.getTime()) ? `Resets: ${reset.toLocaleString()}` : "Reset time unavailable",
    window.cost ? `$${(window.cost.usedUsdCents / 100).toFixed(2)} / $${(window.cost.limitUsdCents / 100).toFixed(2)}` : null,
  ].filter(Boolean).join("\n");
}

export function ProviderUsage({ active }: { active: boolean }) {
  const { snapshot, error } = useProviderUsage(active);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    // Local clock only. Quota and DeepSeek polling retain their own cadence.
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [active]);
  const stale = error || snapshot?.status === "stale";
  const counts = new Map<string, number>();
  for (const provider of snapshot?.providers ?? []) counts.set(provider.label, (counts.get(provider.label) ?? 0) + 1);
  const ordinals = new Map<string, number>();
  const statusLabels = { not_installed: "Not installed", unauthenticated: "Sign in", expired: "Expired", error: "Unavailable", unknown: "–", ok: "No quota" };
  return <section className="host-pulse-float-usage" aria-label="Provider usage">
    <div className="host-pulse-float-usage-heading" title={[snapshot?.groupLabel, "Percentage of allowance used", snapshot?.checkedAt ? `Checked: ${new Date(snapshot.checkedAt).toLocaleString()}` : null].filter(Boolean).join("\n")}>
      <span>Provider usage</span><span>{stale ? "Stale" : "used"}</span>
    </div>
    <div className="host-pulse-float-usage-list">
      {snapshot?.providers.map((provider) => {
        const ordinal = (ordinals.get(provider.label) ?? 0) + 1;
        ordinals.set(provider.label, ordinal);
        const multipleAccounts = (counts.get(provider.label) ?? 0) > 1;
        return <div key={provider.id}>
          <div className="host-pulse-float-usage-row">
            <span className="host-pulse-float-usage-name" title={[provider.label, provider.accountLabel, provider.planLabel].filter(Boolean).join(" · ")}>{provider.label === "Claude Code" ? "Claude" : provider.label}{multipleAccounts ? ` ${ordinal}` : ""}</span>
            <div className="host-pulse-float-usage-windows">
              {provider.windows.length ? provider.windows.map((window, index) => {
                const countdown = quotaResetCountdown(window.resetsAt, now);
                return <div className="host-pulse-float-quota" key={`${window.label}:${index}`} title={quotaTitle(window, countdown.description)} aria-label={`${provider.label}${multipleAccounts ? ` ${ordinal}` : ""}: ${window.label}, ${window.usedPercent}% used, ${countdown.description}${stale ? ", stale" : ""}`}>
                  <div><span>{windowLabel(window.label)}</span><strong>{Number(window.usedPercent.toFixed(1))}%</strong></div>
                  <span className="host-pulse-float-quota-track" aria-hidden="true"><i style={{ width: `${Math.min(100, Math.max(0, window.usedPercent))}%`, background: window.usedPercent >= 95 ? "#ef4444" : window.usedPercent >= 80 ? "#eab308" : "#22c55e" }} /></span>
                  <span className="host-pulse-float-quota-reset" title={countdown.description}><span aria-hidden="true">↻ </span>{countdown.text}</span>
                </div>;
              }) : <span className="host-pulse-float-usage-empty">{statusLabels[provider.status]}</span>}
            </div>
          </div>
          {multipleAccounts ? <div className="host-pulse-float-usage-account">{provider.accountLabel ?? `Account ${ordinal} · label unavailable`}</div> : null}
        </div>;
      })}
      {!snapshot?.providers.length ? <div className="host-pulse-float-usage-empty">{error || (snapshot && snapshot.status !== "ok") ? "Usage unavailable" : snapshot ? "No usage sources" : "Loading…"}</div> : null}
    </div>
  </section>;
}
