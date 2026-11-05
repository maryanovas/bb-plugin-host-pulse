import { useDeepseekBalance } from "../hooks/use-deepseek-balance";

function money(value: string, currency: string) {
  const amount = Number(value);
  const format = new Intl.NumberFormat("en-US", { style: "currency", currency, currencyDisplay: "symbol" });
  // A small positive balance must not look empty after rounding to cents.
  return amount > 0 && amount < 0.01 ? `<${format.format(0.01)}` : format.format(amount);
}

export function DeepseekBalance({ active }: { active: boolean }) {
  const { snapshot, error } = useDeepseekBalance(active);
  const stale = Boolean(snapshot?.balances.length && (error || snapshot.status === "stale"));
  const missing = snapshot?.status === "not_configured" ? "No key"
    : snapshot?.status === "unauthenticated" ? "Check key" : error || snapshot ? "Unavailable" : "Loading…";
  const title = ["DeepSeek API balance · DSH · refresh every 10 seconds while visible",
    stale ? "Last known balance; update failed" : null,
    snapshot?.isAvailable === false ? "Insufficient balance for API calls" : null,
    ...(snapshot?.balances.map((balance) => `${balance.currency}: ${balance.total_balance} total · ${balance.topped_up_balance} topped up · ${balance.granted_balance} granted`) ?? []),
    snapshot?.checkedAt ? `Checked: ${new Date(snapshot.checkedAt).toLocaleString()}` : missing,
  ].filter(Boolean).join("\n");
  return <section className="host-pulse-float-balance" aria-label="DeepSeek API balance" title={title}>
    <span>DeepSeek</span>
    <span className="host-pulse-float-balance-note" data-stale={stale || undefined}>{stale ? "stale" : "left"}</span>
    <strong className="host-pulse-float-balance-value" data-empty={snapshot?.isAvailable === false || undefined}>
      {snapshot?.balances.length ? snapshot.balances.map((balance) => <span key={balance.currency}>{money(balance.total_balance, balance.currency)}</span>) : <span className="host-pulse-float-usage-empty">{missing}</span>}
    </strong>
  </section>;
}
