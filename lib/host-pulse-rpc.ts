import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import { hostPulseRpcContract } from "./rpc-contract.ts";

type Method = keyof typeof hostPulseRpcContract;
type Result<M extends Method> = z.output<(typeof hostPulseRpcContract)[M]["output"]>;

export function createHostPulseRpcClient(plugins: Pick<PluginBrowserBbSdk["plugins"], "callRpc">, pluginId: string) {
  function call<M extends Method>(method: M, input?: null): Promise<Result<M>>;
  async function call(method: Method, input: null = null): Promise<Result<Method>> {
    // The source starts this once per shared request; hiding one viewer cannot
    // cancel another viewer's collection. The SDK forwards abort to fetch/body reads.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("Host Pulse request timed out after 30 seconds", "TimeoutError")), 30_000);
    try {
      const result = await plugins.callRpc<Result<Method>>({ pluginId, method, input, outputSchema: hostPulseRpcContract[method].output, signal: controller.signal });
      controller.signal.throwIfAborted();
      return result;
    } finally { clearTimeout(timer); }
  }
  return { call };
}
