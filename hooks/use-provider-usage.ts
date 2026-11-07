import { useEffect, useState } from "react";
import { useHostPulseRpc } from "./use-host-pulse-rpc";
import type { ProviderUsageSnapshot } from "../lib/provider-usage";
import { createSnapshotSource } from "../lib/snapshot-source";
import { createVisiblePoller } from "../lib/visible-poller";

const source = createSnapshotSource<ProviderUsageSnapshot>((value) => value.refreshIntervalMs);

export function useProviderUsage(active: boolean) {
  const rpc = useHostPulseRpc();
  const [snapshot, setSnapshot] = useState(source.snapshot);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!active) return;
    const poller = createVisiblePoller({
      load: () => source.load(() => rpc.call("provider_usage_snapshot", null)),
      receive(value) { setSnapshot(value); setError(false); },
      error() { setError(true); },
      intervalMs: (value) => value.refreshIntervalMs,
      nextAttemptAt: source.nextAttemptAt,
    });
    poller.setActive(true);
    return () => poller.dispose();
  }, [active, rpc]);
  return { snapshot, error };
}
