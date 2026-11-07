import { useEffect, useState } from "react";
import { useHostPulseRpc } from "./use-host-pulse-rpc";
import type { DeepseekBalanceSnapshot } from "../lib/deepseek-balance-schema";
import { createSnapshotSource } from "../lib/snapshot-source";
import { createVisiblePoller } from "../lib/visible-poller";

const source = createSnapshotSource<DeepseekBalanceSnapshot>((value) => value.refreshIntervalMs);

export function useDeepseekBalance(active: boolean) {
  const rpc = useHostPulseRpc();
  const [snapshot, setSnapshot] = useState(source.snapshot);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!active) return;
    const poller = createVisiblePoller({
      load: () => source.load(() => rpc.call("deepseek_balance_snapshot", null)),
      receive(value) { setSnapshot(value); setError(false); },
      error() { setError(true); },
      intervalMs: (value) => value.refreshIntervalMs,
      nextAttemptAt: source.nextAttemptAt,
      subscribe: source.subscribe,
    });
    poller.setActive(true);
    return () => poller.dispose();
  }, [active, rpc]);
  return { snapshot, error };
}
