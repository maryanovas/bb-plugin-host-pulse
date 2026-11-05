export interface MonitorPosition { x: number; y: number }
export interface MonitorBounds { left: number; top: number; width: number; height: number }
export interface MonitorPreferences {
  version: 1;
  visible: boolean;
  position: MonitorPosition | null;
}

export const MONITOR_STORAGE_KEY = "host-pulse-floating-monitor-v1";
const LEGACY_STORAGE_KEY = "beacon-floating-monitor-v1";
const DEFAULTS: MonitorPreferences = { version: 1, visible: false, position: null };

export function parseMonitorPreferences(raw: string | null): MonitorPreferences {
  try {
    if (!raw || raw.length > 1024) return DEFAULTS;
    const value = JSON.parse(raw);
    if (!value || value.version !== 1 || typeof value.visible !== "boolean") return DEFAULTS;
    const p = value.position;
    const position = p && typeof p.x === "number" && Number.isFinite(p.x) && typeof p.y === "number" && Number.isFinite(p.y)
      ? { x: p.x, y: p.y } : null;
    return { version: 1, visible: value.visible, position };
  } catch { return DEFAULTS; }
}

/** Keep the drag handle and controls reachable after resize or restoring on another screen. */
export function clampMonitorPosition(position: MonitorPosition, bounds: MonitorBounds, size: { width: number; height: number }): MonitorPosition {
  const left = bounds.left + 8;
  const top = bounds.top + 8;
  return {
    x: Math.min(Math.max(left, bounds.left + bounds.width - size.width - 8), Math.max(left, position.x)),
    y: Math.min(Math.max(top, bounds.top + bounds.height - size.height - 8), Math.max(top, position.y)),
  };
}

/** One preference store per app window; storage is best-effort and contains no telemetry. */
export function createMonitorPreferences(storage: () => Pick<Storage, "getItem" | "setItem">) {
  let state: MonitorPreferences | undefined;
  const listeners = new Set<() => void>();
  const getSnapshot = () => {
    if (!state) {
      try {
        const persisted = storage();
        const current = persisted.getItem(MONITOR_STORAGE_KEY);
        const legacy = current === null ? persisted.getItem(LEGACY_STORAGE_KEY) : null;
        state = parseMonitorPreferences(current ?? legacy);
        if (current === null && legacy !== null) {
          // Import once without changing Beacon's separate browser preferences.
          try { persisted.setItem(MONITOR_STORAGE_KEY, JSON.stringify(state)); } catch { /* Keep the imported state in memory. */ }
        }
      }
      catch { state = DEFAULTS; }
    }
    return state;
  };
  const update = (patch: Partial<Pick<MonitorPreferences, "visible" | "position">>) => {
    const current = getSnapshot();
    const next = { ...current, ...patch };
    if (next.visible === current.visible && next.position?.x === current.position?.x && next.position?.y === current.position?.y) return;
    state = next;
    try { storage().setItem(MONITOR_STORAGE_KEY, JSON.stringify(next)); } catch { /* Works in memory if storage is blocked. */ }
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setVisible(visible: boolean) { update({ visible }); },
    setPosition(position: MonitorPosition) { update({ position }); },
  };
}
