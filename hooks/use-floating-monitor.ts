import { useSyncExternalStore } from "react";
import { createMonitorPreferences } from "../lib/floating-monitor-state";

export const floatingMonitor = createMonitorPreferences(() => window.localStorage);
export function useFloatingMonitor() {
  return useSyncExternalStore(floatingMonitor.subscribe, floatingMonitor.getSnapshot);
}
