import { useMemo } from "react";
import { useSdk, experimental_usePluginId } from "@get-bb/plugin-sdk/app";
import { createHostPulseRpcClient } from "../lib/host-pulse-rpc";

/** Share request ownership through the snapshot source, independently of a viewer. */
export function useHostPulseRpc() {
  const sdk = useSdk();
  const pluginId = experimental_usePluginId();
  return useMemo(() => createHostPulseRpcClient(sdk.plugins, pluginId), [sdk, pluginId]);
}
