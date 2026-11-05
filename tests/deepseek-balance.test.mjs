import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { createDeepseekBalanceReader, deepseekBalanceResponseSchema } from "../lib/deepseek-balance.ts";
import { readDshApiKey } from "../lib/dsh-credentials.ts";

const fixture = (total = "18.35", currency = "USD") => ({
  is_available: Number(total) > 0,
  balance_infos: [{ currency, total_balance: total, granted_balance: "0.00", topped_up_balance: total }],
});
const response = (total) => Response.json(fixture(total));

test("the balance contract preserves zero, exact decimals, and separate currencies", () => {
  const value = fixture("0.00");
  value.balance_infos.push(fixture("1.002", "CNY").balance_infos[0]);
  const parsed = deepseekBalanceResponseSchema.parse(value);
  assert.equal(parsed.is_available, false);
  assert.equal(parsed.balance_infos[0].total_balance, "0.00");
  assert.equal(parsed.balance_infos[1].total_balance, "1.002");
  assert.throws(() => deepseekBalanceResponseSchema.parse(fixture("NaN")));
  assert.throws(() => deepseekBalanceResponseSchema.parse(fixture("1", "EUR")));
  assert.throws(() => deepseekBalanceResponseSchema.parse({ ...value, balance_infos: [value.balance_infos[0], value.balance_infos[0]] }));
});

test("multiple viewers share one demand-only request, then wait ten seconds", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 100_000 });
  let keys = 0, calls = 0;
  const reader = createDeepseekBalanceReader(async () => { keys++; return "test-key"; }, async (url, options) => {
    calls++;
    assert.equal(url, "https://api.deepseek.com/user/balance");
    assert.equal(options.method, "GET");
    assert.equal(options.headers.Authorization, "Bearer test-key");
    assert.equal(options.redirect, "error");
    return response();
  });
  t.after(() => reader.dispose());
  assert.equal(keys, 0);
  const results = await Promise.all(Array.from({ length: 20 }, () => reader.read()));
  assert.ok(results.every((r) => r === results[0]));
  assert.equal(results[0].refreshIntervalMs, 10_000);
  assert.equal(calls, 1);
  t.mock.timers.tick(9999); await reader.read(); assert.equal(calls, 1);
  t.mock.timers.tick(1); await reader.read(); assert.equal(calls, 2);
  t.mock.timers.tick(60_000); assert.equal(calls, 2); // No autonomous poll.
  assert.equal(keys, 2);
});

test("failures retain the last balance, never expose raw errors, and retry no sooner than ten seconds", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 100_000 });
  let fail = false, calls = 0;
  const reader = createDeepseekBalanceReader(async () => "test-secret", async () => {
    calls++;
    if (fail) throw new Error("Authorization: Bearer test-secret");
    return response();
  });
  t.after(() => reader.dispose());
  const good = await reader.read();
  fail = true; t.mock.timers.tick(10_000);
  const stale = await reader.read();
  assert.equal(stale.status, "stale");
  assert.equal(stale.checkedAt, good.checkedAt);
  assert.deepEqual(stale.balances, good.balances);
  assert.ok(!JSON.stringify(stale).includes("test-secret"));
  await reader.read(); assert.equal(calls, 2);
  fail = false; t.mock.timers.tick(10_000);
  assert.equal((await reader.read()).status, "ok");
});

test("missing credentials do not make a request or invent a zero balance", async (t) => {
  let calls = 0;
  const reader = createDeepseekBalanceReader(async () => null, async () => { calls++; return response(); });
  t.after(() => reader.dispose());
  const value = await reader.read();
  assert.equal(value.status, "not_configured");
  assert.equal(value.checkedAt, null);
  assert.deepEqual(value.balances, []);
  assert.equal(calls, 0);
});

test("changed credentials cannot inherit the previous account's balance", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 100_000 });
  let key = "first-account";
  const reader = createDeepseekBalanceReader(async () => key, async () => key === "first-account" ? response() : Response.json({ message: "private-detail" }, { status: 500 }));
  t.after(() => reader.dispose());
  assert.equal((await reader.read()).status, "ok");
  key = "second-account"; t.mock.timers.tick(10_000);
  const value = await reader.read();
  assert.equal(value.status, "unavailable");
  assert.deepEqual(value.balances, []);
  assert.ok(!JSON.stringify(value).includes("private-detail"));
});

test("a failed credential lookup invalidates the previous account instead of showing its balance as stale", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 100_000 });
  let failCredentials = false, calls = 0;
  const reader = createDeepseekBalanceReader(async () => {
    if (failCredentials) throw new Error("DSH configuration changed; private credential details");
    return "first-account";
  }, async () => { calls++; return response(); });
  t.after(() => reader.dispose());
  assert.equal((await reader.read()).status, "ok");
  failCredentials = true; t.mock.timers.tick(10_000);
  const value = await reader.read();
  assert.equal(value.status, "unavailable");
  assert.deepEqual(value.balances, []);
  assert.equal(value.checkedAt, null);
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(value).includes("private credential details"));
  failCredentials = false; t.mock.timers.tick(10_000);
  assert.equal((await reader.read()).status, "ok");
});

test("rejected keys and malformed provider responses have explicit unavailable states", async (t) => {
  for (const [status, body, expected] of [[401, { message: "private-key" }, "unauthenticated"], [200, fixture("invalid"), "unavailable"], [429, {}, "unavailable"]]) {
    const reader = createDeepseekBalanceReader(async () => "test-key", async () => Response.json(body, { status }));
    t.after(() => reader.dispose());
    const value = await reader.read();
    assert.equal(value.status, expected);
    assert.deepEqual(value.balances, []);
    assert.ok(!JSON.stringify(value).includes("private-key"));
  }
});

test("disposal aborts requests and prevents a late balance from reviving the cache", async () => {
  let finish, signal, started;
  const ready = new Promise((resolve) => { started = resolve; });
  const reader = createDeepseekBalanceReader(async () => "test-key", (_url, options) => {
    signal = options.signal;
    started();
    return new Promise((resolve) => { finish = resolve; });
  });
  const pending = reader.read();
  await ready;
  reader.dispose();
  assert.equal(signal.aborted, true);
  finish(response());
  await assert.rejects(pending, { name: "AbortError" });
  await assert.rejects(reader.read(), /disposed/);
});

async function credentialFiles(t) {
  const home = await mkdtemp(join(tmpdir(), "host-pulse-dsh-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, ".dsh"));
  await writeFile(join(home, ".dsh", ".env"), 'DEEPSEEK_API_KEY="file-key" # comment\n', { mode: 0o600 });
  return home;
}
const agents = [{ id: "deepseek", command: "/bin/dsh" }];

test("empty ACP custom agents mean no DSH account; malformed nonempty settings still fail", async () => {
  const signal = new AbortController().signal;
  for (const value of ["", " \n\t", "[]"]) assert.equal(await readDshApiKey(value, signal, {}), null);
  await assert.rejects(readDshApiKey("{", signal, {}), SyntaxError);
  await assert.rejects(readDshApiKey("{}", signal, {}));
});

test("DSH's existing dotenv key is parsed without executing it and reread after a change", async (t) => {
  const home = await credentialFiles(t), signal = new AbortController().signal;
  assert.equal(await readDshApiKey(JSON.stringify(agents), signal, {}, home), "file-key");
  await writeFile(join(home, ".dsh", ".env"), 'export DEEPSEEK_API_KEY=changed-key\n');
  assert.equal(await readDshApiKey(agents, signal, {}, home), "changed-key");
  assert.equal(await readDshApiKey([], signal, {}, home), null);
});

test("custom DSH environment overrides inherited values and supports its own home", async (t) => {
  const home = await credentialFiles(t), signal = new AbortController().signal;
  const custom = [{ ...agents[0], env: { DEEPSEEK_API_KEY: "custom-key" } }];
  assert.equal(await readDshApiKey(custom, signal, { DEEPSEEK_API_KEY: "inherited-key" }, home), "custom-key");
  assert.equal(await readDshApiKey(agents, signal, { DEEPSEEK_API_KEY: "inherited-key" }, home), "inherited-key");
  const other = join(home, "other");
  await mkdir(other); await writeFile(join(other, ".env"), "DEEPSEEK_API_KEY=other-key");
  assert.equal(await readDshApiKey([{ ...agents[0], env: { DSH_HOME: other } }], signal, {}, home), "other-key");
  await writeFile(join(home, ".dsh", ".credentials.yaml"), "version: 1\nrefs: {}\n");
  await assert.rejects(readDshApiKey(agents, signal, {}, home), /managed credential store/);
});

test("DSH home follows the merged launch home, including tilde and managed credentials", async (t) => {
  const home = await credentialFiles(t), signal = new AbortController().signal;
  const agentHome = join(home, "agent-home");
  await mkdir(join(agentHome, ".dsh"), { recursive: true });
  await writeFile(join(agentHome, ".dsh", ".env"), "DEEPSEEK_API_KEY=agent-home-key\n");
  const homeVariable = process.platform === "win32" ? "USERPROFILE" : "HOME";
  const launchEnv = { [homeVariable]: agentHome };
  for (const dshHome of [undefined, "", "  ", "~/.dsh", "~\\.dsh"]) {
    await t.test(`launch home with DSH_HOME ${JSON.stringify(dshHome)}`, async () => {
      const env = { ...launchEnv, ...(dshHome === undefined ? {} : { DSH_HOME: dshHome }) };
      assert.equal(await readDshApiKey([{ ...agents[0], env }], signal, { [homeVariable]: home }, home), "agent-home-key");
    });
  }
  await t.test("inherited launch home also overrides the resolver's fallback", async () => {
    assert.equal(await readDshApiKey(agents, signal, launchEnv, home), "agent-home-key");
  });
  await writeFile(join(agentHome, ".dsh", ".credentials.yaml"), "version: 1\nrefs: {}\n");
  await assert.rejects(readDshApiKey([{ ...agents[0], env: launchEnv }], signal, {}, home), /managed credential store/);
});

test("explicit DSH_HOME takes precedence and relative paths require the configured agent cwd", async (t) => {
  const home = await credentialFiles(t), signal = new AbortController().signal;
  const explicitHome = join(home, "explicit ");
  await mkdir(explicitHome);
  await writeFile(join(explicitHome, ".env"), "DEEPSEEK_API_KEY=explicit-home-key\n");
  const homeVariable = process.platform === "win32" ? "USERPROFILE" : "HOME";
  const custom = [{ ...agents[0], env: { [homeVariable]: join(home, "other"), DSH_HOME: explicitHome } }];
  assert.equal(await readDshApiKey(custom, signal, { DSH_HOME: join(home, ".dsh") }, home), "explicit-home-key");
  const relative = [{ ...agents[0], cwd: home, env: { DSH_HOME: ".dsh" } }];
  assert.equal(await readDshApiKey(relative, signal, {}, home), "file-key");
  await assert.rejects(readDshApiKey([{ ...agents[0], env: { DSH_HOME: ".dsh" } }], signal, {}, home), /DSH home must be absolute/);
});

test("an empty key in the explicit agent cwd blocks fallback to another home account", async (t) => {
  const home = await credentialFiles(t), signal = new AbortController().signal;
  const cwd = join(home, "project");
  await mkdir(cwd);
  await writeFile(join(cwd, ".env"), "DEEPSEEK_API_KEY=\n");
  const custom = [{ ...agents[0], cwd }];
  assert.equal(await readDshApiKey(custom, signal, {}, home), null);
  await writeFile(join(cwd, ".env"), "UNRELATED=value\n");
  assert.equal(await readDshApiKey(custom, signal, {}, home), "file-key");
});

test("an empty launch key permits dotenv fallback but never revives an overridden inherited key", async (t) => {
  const home = await credentialFiles(t), signal = new AbortController().signal;
  const cwd = join(home, "project");
  await mkdir(cwd);
  const custom = [{ ...agents[0], cwd, env: { DEEPSEEK_API_KEY: "" } }];
  const inherited = { DEEPSEEK_API_KEY: "inherited-key" };
  await writeFile(join(cwd, ".env"), "DEEPSEEK_API_KEY=project-key\n");
  assert.equal(await readDshApiKey(custom, signal, inherited, home), "project-key");
  await writeFile(join(cwd, ".env"), "UNRELATED=value\n");
  assert.equal(await readDshApiKey(custom, signal, inherited, home), "file-key");
  await writeFile(join(cwd, ".env"), "DEEPSEEK_API_KEY=\n");
  assert.equal(await readDshApiKey(custom, signal, inherited, home), null);
  assert.equal(await readDshApiKey([{ ...agents[0], cwd }], signal, inherited, home), "inherited-key");
});

test("balance lookup failures stay independent of CPU and quota readers", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "host-pulse" });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  const balance = await harness.behavior.callRpc("deepseek_balance_snapshot", null);
  assert.equal(balance.status, "unavailable");
  assert.deepEqual(balance.balances, []);
  const metrics = await harness.behavior.callRpc("metrics_snapshot", null);
  assert.ok(metrics.cpu.cores > 0);
  assert.equal((await harness.behavior.callRpc("provider_usage_snapshot", null)).status, "unavailable");
});
