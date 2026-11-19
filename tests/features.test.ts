/**
 * 新功能测试：预设插件管理、TUI 渲染、Tavily 解析。
 * 全部离线，零网络零费用。
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  PresetManager,
  applyToolPolicy,
  defaultPresetFile,
  normalizePolicy,
  renderBanner,
  renderDone,
  renderEvent,
  newRenderState,
  parseTavilyJson,
  createWebSearchTool,
  clearSearchCache,
  ScriptedLLM,
  ToolRegistry,
  Scope,
  Session,
  say,
} from "../src";
import type { ToolDefinition, SessionEvent } from "../src";
import { runTui } from "../src/tui";
import { parseArgv } from "../src/cli/args";
import { resolveConfig } from "../src/cli/config";

function baseEnv(): NodeJS.ProcessEnv {
  return { HOME: tmpdir(), DSH_HOME: tmpdir(), PATH: process.env.PATH };
}

// ===== 预设插件管理 =====

test("PresetManager 默认带 3 个内置预设，按 order 排序", () => {
  const m = new PresetManager();
  const ids = m.list().map((p) => p.id);
  assert.deepEqual(ids, ["builtin:web", "builtin:search-only", "builtin:readonly-crawl"]);
  assert.ok(m.list().every((p) => p.builtin === true));
});

test("工具策略：all 返回 undefined；whitelist/exclude 正确过滤", () => {
  const universe = ["web_search", "fetch_url", "extract_links", "save_markdown"];
  assert.equal(applyToolPolicy({ mode: "all", names: [] }, universe), undefined);
  assert.deepEqual(applyToolPolicy({ mode: "whitelist", names: ["web_search", "not_exist"] }, universe), ["web_search"]);
  assert.deepEqual(applyToolPolicy({ mode: "exclude", names: ["save_markdown"] }, universe), ["web_search", "fetch_url", "extract_links"]);
});

test("空白名单归一为全量（与 DSH 行为一致）", () => {
  assert.deepEqual(normalizePolicy({ mode: "whitelist", names: [] }), { mode: "all", names: [] });
  assert.deepEqual(normalizePolicy({ mode: "whitelist", names: [" a ", "a", ""] }), { mode: "whitelist", names: ["a"] });
});

test("预设的 upsert/duplicate/启停/两步删除", () => {
  const m = new PresetManager();
  const created = m.upsert({
    name: "测试预设",
    description: "单测",
    enabled: true,
    order: 50,
    role: "测试助手",
    tools: { mode: "whitelist", names: ["fetch_url"] },
    scope: { maxTurns: 3 },
    extraRules: ["只答是或否"],
  });
  assert.ok(created.id.startsWith("custom-"));
  assert.equal(m.get(created.id)?.role, "测试助手");

  const copy = m.duplicate(created.id);
  assert.notEqual(copy.id, created.id);
  assert.equal(copy.name, "测试预设 副本");

  m.setEnabled(created.id, false);
  assert.equal(m.get(created.id)?.enabled, false);
  assert.throws(() => m.remove(created.id), /二次确认/);
  m.remove(created.id, true);
  assert.equal(m.has(created.id), false);
});

test("内置预设不可删除/覆盖，但可启停", () => {
  const m = new PresetManager();
  m.setEnabled("builtin:web", false);
  assert.equal(m.get("builtin:web")?.enabled, false);
  assert.throws(() => m.remove("builtin:web", true), /不可删除/);
  assert.throws(
    () => m.upsert({ id: "builtin:web", name: "x", description: "", enabled: true, order: 1, role: "", tools: { mode: "all", names: [] }, scope: {}, extraRules: [] }),
    /不可覆盖/,
  );
});

test("activate / use：禁用项不能激活；active 自动回退到第一个启用项", () => {
  const m = new PresetManager();
  m.use("builtin:search-only");
  assert.equal(m.active?.id, "builtin:search-only");
  m.setEnabled("builtin:search-only", false);
  assert.equal(m.active?.id, "builtin:web"); // 回退
  assert.throws(() => m.use("builtin:search-only"), /已禁用/);
});

test("resolve：输出人设/工具名/scope 覆盖/额外规则", () => {
  const m = new PresetManager();
  const r = m.resolve({ id: "builtin:search-only", universe: ["web_search", "fetch_url"] });
  assert.equal(r?.role, "网页搜索助手，只返回候选链接与摘要，不抓取正文");
  assert.deepEqual(r?.toolNames, ["web_search"]);
  assert.equal(r?.scope.maxTurns, 4);
  assert.ok(r && r.extraRules.length > 0);
});

test("预设文件持久化：save 后 loadSync 还原启停/激活状态", async () => {
  const dir = await mkdtemp(join(tmpdir(), "preset-persist-"));
  const file = join(dir, "presets.json");
  const mgr = new PresetManager();
  mgr.use("builtin:readonly-crawl");
  mgr.setEnabled("builtin:search-only", false);
  await mgr.save(file);

  const loaded = PresetManager.loadSync(file);
  assert.equal(loaded.active?.id, "builtin:readonly-crawl");
  assert.equal(loaded.get("builtin:search-only")?.enabled, false);
});

test("预设文件损坏时 loadSync 降级到内置默认", async () => {
  const dir = await mkdtemp(join(tmpdir(), "preset-bad-"));
  const file = join(dir, "presets.json");
  await writeFile(file, "{not json", "utf8");
  let warning = "";
  const m = PresetManager.loadSync(file, (msg) => (warning = msg));
  assert.equal(m.list().length, 3);
  assert.match(warning, /损坏/);
});

test("manifest 导出/导入：只更新本地已有 id 的元信息", () => {
  const m = new PresetManager();
  const manifest = m.manifest();
  assert.ok(manifest.length > 0);
  assert.equal("role" in manifest[0]!, false); // 元信息不含提示词
  manifest[0]!.name = "改名";
  manifest.push({ id: "ghost", name: "x", description: "", enabled: true, order: 99 });
  const { updated, skipped } = m.importManifest(manifest);
  assert.equal(updated, 3);
  assert.equal(skipped, 1);
  assert.equal(m.get(manifest[0]!.id)?.name, "改名");
});

// ===== CLI 集成 =====

test("parseArgv 识别 tui 与 preset 各操作", () => {
  assert.equal(parseArgv(["tui"]).kind, "tui");
  const use = parseArgv(["preset", "use", "builtin:web"]);
  assert.equal(use.kind, "preset");
  if (use.kind === "preset") assert.deepEqual(use.operation, { action: "use", id: "builtin:web" });
  const imp = parseArgv(["preset", "import", "x.json", "--json"]);
  if (imp.kind === "preset") assert.deepEqual(imp.operation, { action: "import", file: "x.json" });
  assert.throws(() => parseArgv(["preset", "use"]));
});

test("resolveConfig：--preset 覆盖默认工具/角色/预算，命令行显式参数仍最高优先", () => {
  const base = { json: false, quiet: true, hosts: [] as string[] };
  const cfg = resolveConfig({ ...base, preset: "builtin:search-only" }, baseEnv());
  assert.deepEqual(cfg.tools, ["web_search"]);
  assert.equal(cfg.maxTurns, 4);
  assert.match(cfg.role!, /只返回候选链接/);
  assert.equal(cfg.preset?.id, "builtin:search-only");

  const cfg2 = resolveConfig({ ...base, preset: "builtin:search-only", tools: ["fetch_url"], maxTurns: 2, role: "自定义" }, baseEnv());
  assert.deepEqual(cfg2.tools, ["fetch_url"]);
  assert.equal(cfg2.maxTurns, 2);
  assert.equal(cfg2.role, "自定义");
});

test("defaultPresetFile 遵循 DSH_HOME", () => {
  const env = { DSH_HOME: "/tmp/my-dsh" };
  assert.equal(defaultPresetFile(env), join("/tmp/my-dsh", "presets.json"));
});

// ===== TUI 渲染 =====

test("renderBanner 含 DSH / agent 名 / 快捷键", () => {
  const s = renderBanner({ agent: "agent-harness", llm: "deepseek/deepseek-flash" });
  assert.match(s, /DDDD/);
  assert.match(s, /agent-harness/);
  assert.match(s, /Esc 取消/);
});

test("renderEvent：工具调用与结果配对算出耗时，web_search 显示为 web-search", () => {
  const st = newRenderState();
  const call: SessionEvent = {
    seq: 1, ts: 1000, turn: 1, type: "tool.call",
    data: { name: "web_search", args: { query: "test" }, callId: "c1" },
  };
  const result: SessionEvent = {
    seq: 2, ts: 1388, turn: 1, type: "tool.result",
    data: { name: "web_search", callId: "c1", isError: false, chars: 100 },
  };
  const a = renderEvent(call, st);
  assert.match(a!, /web-search/);
  assert.match(a!, /test/);
  const b = renderEvent(result, st);
  assert.match(b!, /388 ms/);
  assert.equal(st.pending, 0);
  assert.equal(st.toolCalls, 1);
});

test("renderEvent：缓存命中被计数", () => {
  const st = newRenderState();
  renderEvent({ seq: 1, ts: 1, turn: 1, type: "tool.note", data: { event: "search.cache" } }, st);
  assert.equal(st.cacheHits, 1);
});

test("renderDone 含本轮完成 / 模型 / 待处理 / 会话路径", () => {
  const s = renderDone(
    { status: "completed", text: "", turns: 2, toolCalls: 1, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
    500,
    { model: "deepseek/deepseek-flash", sessionPath: "/tmp/s.jsonl", cacheHits: 1, pending: 0 },
  );
  assert.match(s, /本轮完成/);
  assert.match(s, /deepseek\/deepseek-flash/);
  assert.match(s, /待处理 0/);
  assert.match(s, /\/tmp\/s\.jsonl/);
});

// ===== TUI 驱动（离线用 ScriptedLLM） =====

test("runTui 能启动并驱动一次 web_search 工具调用，随后 /exit", async () => {
  const echoes: string[] = [];
  const fakeTool: ToolDefinition = {
    name: "web_search",
    description: "fake",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    run(input) {
      echoes.push(String(input.query));
      return { content: JSON.stringify({ count: 1, results: [{ title: "t", url: "https://x.test", snippet: "s" }] }) };
    },
  };
  const llm = new ScriptedLLM([
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "web_search", args: { query: "二阶功能" } }] },
    say("根据搜索结果，这是某一式。"),
  ]);
  const inputs = ["二阶功能是啥", "/exit"];
  let i = 0;
  const lines: string[] = [];
  const io = {
    async ask() { return inputs[i++] ?? null; },
    print(line = "") { lines.push(line); },
  };

  const mgr = new PresetManager();
  const dir = await mkdtemp(join(tmpdir(), "tui-run-"));
  const outcome = await runTui({
    llm, tools: [fakeTool], scope: new Scope({ maxTurns: 4, maxToolCalls: 4 }),
    role: "测试", io, presetManager: mgr, sessionDir: dir, color: false,
  });

  assert.equal(outcome.reason, "exit");
  assert.equal(outcome.tasks, 1);
  assert.deepEqual(echoes, ["二阶功能"]);
  assert.ok(lines.some((l) => /web-search/.test(l)), "时间线应显示 web-search");
  assert.ok(lines.some((l) => /本轮完成/.test(l)), "应显示本轮完成");
  assert.ok(outcome.sessionPath && /session\.jsonl$/.test(outcome.sessionPath), "应落盘 session.jsonl");
});

// ===== Tavily =====

test("parseTavilyJson 正确抽取结构化结果并过滤非法 URL", () => {
  const hits = parseTavilyJson({
    results: [
      { title: "A", url: "https://a.test/x", content: "摘要A" },
      { title: "B", url: "javascript:alert(1)", content: "x" },
      { title: "", url: "https://b.test", content: "y" },
    ],
  }, 10);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.title, "A");
  assert.equal(hits[0]!.snippet, "摘要A");
});

test("Tavily 后端：缺 key 直接报错，不发起网络请求", async () => {
  clearSearchCache();
  const tool = createWebSearchTool({ provider: "tavily", apiKey: undefined, fetchImpl: (async () => {
    throw new Error("不应被调用");
  }) as typeof fetch });
  const ctx = {
    scope: new Scope(), sessionId: "x", logger: () => {},
  };
  const res = await tool.run({ query: "test" }, ctx);
  assert.equal(res.isError, true);
  assert.match(res.content, /DSH_TAVILY_KEY/);
});

test("Tavily 后端：用注入 fetch 返回 JSON 并解析；重复查询命中缓存不发第二次请求", async () => {
  clearSearchCache();
  let calls = 0;
  const tool = createWebSearchTool({
    provider: "tavily",
    apiKey: "test-key",
    // 注意：注入 fetchImpl 会关闭缓存，这里单独验证解析
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      calls += 1;
      assert.equal(init?.method, "POST");
      assert.match(String(init?.body), /test-key/);
      return { ok: true, text: async () => JSON.stringify({ results: [{ title: "R", url: "https://r.test", content: "c" }] }), json: async () => ({ results: [{ title: "R", url: "https://r.test", content: "c" }] }) } as unknown as Response;
    }) as typeof fetch,
  });
  const ctx = { scope: new Scope(), sessionId: "x", logger: () => {} };
  const r1 = await tool.run({ query: "abc" }, ctx);
  assert.equal((JSON.parse(r1.content) as { count: number }).count, 1);
  await tool.run({ query: "abc" }, ctx);
  assert.equal(calls, 2); // 注入 fetch 时缓存关闭，所以两次都真的请求
});
