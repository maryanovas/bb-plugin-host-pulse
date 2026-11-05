import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";

const agentsSchema = z.array(z.object({
  id: z.string(), command: z.string(), cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
}));

/** Read the installed local DSH provider's existing key; never execute/shell-source .env. */
export async function readDshApiKey(
  customAgents: unknown,
  signal: AbortSignal,
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): Promise<string | null> {
  if (typeof customAgents === "string" && customAgents.trim() === "") return null;
  const agents = agentsSchema.parse(typeof customAgents === "string" ? JSON.parse(customAgents) : customAgents);
  const agent = agents.find((item) => item.id === "deepseek" && /^(dsh|dsh\.cmd|dsh\.exe)$/.test(basename(item.command)));
  if (!agent) return null;
  const env = { ...environment, ...agent.env };
  // DSH resolves Node's home from its launch environment, which can differ from Host Pulse's.
  const agentHome = env[process.platform === "win32" ? "USERPROFILE" : "HOME"] ?? home;
  const root = env.DSH_HOME?.trim() ? env.DSH_HOME : join(agentHome, ".dsh");
  const expanded = root === "~" ? agentHome : root.startsWith("~/") || root.startsWith("~\\") ? join(agentHome, root.slice(2)) : root;
  // A global card cannot infer a thread's working directory or per-project account.
  if (!isAbsolute(expanded) && !agent.cwd) throw new Error("DSH home must be absolute");
  const dshHome = resolve(agent.cwd ?? agentHome, expanded);
  const readOptional = async (path: string) => {
    try {
      const value = await readFile(path, { encoding: "utf8", signal });
      if (value.length > 65_536) throw new Error("DSH credential file too large");
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  // This local adapter targets the configured environment/.env account. A newer
  // managed credential store takes precedence in DSH; don't silently use a different key.
  if (await readOptional(join(dshHome, ".credentials.yaml")) !== null) throw new Error("DSH managed credential store is unsupported");
  // DSH skips an empty launch key, but a present empty project key masks the home file.
  const key = env.DEEPSEEK_API_KEY || (
    (agent.cwd ? parseEnv(await readOptional(join(agent.cwd, ".env")) ?? "").DEEPSEEK_API_KEY : undefined)
    ?? parseEnv(await readOptional(join(dshHome, ".env")) ?? "").DEEPSEEK_API_KEY
  );
  if (!key) return null;
  if (key.length > 4096 || /\s/.test(key)) throw new Error("Invalid DSH key");
  return key;
}
