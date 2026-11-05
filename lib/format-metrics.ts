export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index = Math.max(0, Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1));
  const precision = index < 2 ? 0 : index === 2 ? 1 : 2;
  return `${(bytes / 1024 ** index).toFixed(precision)} ${units[index]}`;
}

export function colorForPercent(value: number | null): string {
  if (value !== null && value >= 95) return "#ef4444";
  if (value !== null && value >= 75) return "#eab308";
  return "#22c55e";
}
