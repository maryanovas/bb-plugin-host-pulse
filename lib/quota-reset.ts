/** A countdown describes the reported deadline; it never assumes a quota reset. */
export function quotaResetCountdown(resetsAt: string | null, now: number): { text: string; description: string } {
  const deadline = resetsAt ? Date.parse(resetsAt) : NaN;
  if (!Number.isFinite(deadline) || !Number.isFinite(now)) return { text: "—", description: "Время сброса недоступно" };
  const remaining = deadline - now;
  if (remaining <= 0) return { text: "ждём", description: "Время сброса наступило; ожидаем обновления от провайдера" };
  if (remaining < 60_000) return { text: "<1м", description: "До сброса меньше минуты" };
  const minutes = Math.floor(remaining / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes / 60) % 24;
  const rest = minutes % 60;
  const text = days > 0 ? `${days}д${hours ? ` ${hours}ч` : ""}`
    : hours > 0 ? `${hours}ч${rest ? ` ${rest}м` : ""}` : `${rest}м`;
  return { text, description: `До сброса: ${text}` };
}
