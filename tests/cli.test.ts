/**
 * CLI 层测试：全部离线、零网络、零费用。
 *
 * 覆盖四类：
 *   1) 参数解析（纯函数，最容易写错也最容易测）
 *   2) 配置优先级（命令行 > DSH_* > DEEPSEEK_* > 默认）
 *   3) 交互会话的上下文保持（这是"聊天"能不能用的唯一关键点）
 *   4) doctor / remote 的判定与命令拼装
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Scope, ScriptedLLM, ToolRegistry, say } from "../src";
import type { ChatRequest } from "../src";
import { UsageError, parseArgv, parseHosts } from "../src/cli/args";
import { runChat } from "../src/cli/chat";
import { resolveConfig } from "../src/cli/config";
import { parseSshHosts, runDoctor } from "../src/cli/doctor";
import { main } from "../src/cli/index";
import { runPromptTask, toJson } from "../src/cli/prompt";
import { extractTitle, formatRead, htmlToText, readUrl } from "../src/cli/read";
import { buildRemoteCommand, buildSshArgv, shellQuote } from "../src/cli/remote";
import { parseSearchHtml, parseDuckDuckGoHtml, createWebSearchTool } from "../src/tools/builtin/websearch";
import { createToolset } from "../src/tools/toolset";

// ===== 参数解析 =====

test("不带参数进入交互聊天", () => {
  const cmd = parseArgv([]);
  assert.equal(cmd.kind, "chat");
});

test("prompt 子命令把多个词拼成一句任务，并解析出限制参数", () => {
  const cmd = parseArgv(["prompt", "抓取首页", "并总结", "--allow-host", "example.com,https://a.test/x", "--max-turns", "3"]);
  assert.equal(cmd.kind, "prompt");
  if (cmd.kind !== "prompt") return;
  assert.equal(cmd.task, "抓取首页 并总结");
  assert.deepEqual(cmd.options.hosts, ["example.com", "a.test"]);
  assert.equal(cmd.options.maxTurns, 3);
});

test("doctor 与 remote 子命令解析", () => {
  const doctor = parseArgv(["doctor", "--json", "--strict"]);
  assert.equal(doctor.kind, "doctor");
  if (doctor.kind === "doctor") {
    assert.equal(doctor.json, true);
    assert.equal(doctor.strict, true);
  }

  const remote = parseArgv(["remote", "4090", "--prompt", "查看 GPU 状态"]);
  assert.equal(remote.kind, "remote");
  if (remote.kind === "remote") {
    assert.equal(remote.host, "4090");
    assert.equal(remote.prompt, "查看 GPU 状态");
  }

  const remoteChat = parseArgv(["remote", "node03"]);
  assert.equal(remoteChat.kind, "remote");
  if (remoteChat.kind === "remote") assert.equal(remoteChat.prompt, undefined);
});

test("未知子命令 / 缺任务文本 / 未知选项都抛 UsageError", () => {
  assert.throws(() => parseArgv(["bogus"]), UsageError);
  assert.throws(() => parseArgv(["prompt"]), UsageError);
  assert.throws(() => parseArgv(["--nope"]), UsageError);
  assert.throws(() => parseArgv(["--model"]), UsageError);
});

test("--allow-host 支持 URL、通配符与去重", () => {
  assert.deepEqual(parseHosts("https://Example.com/a/b, *.foo.com ,example.com"), ["example.com", "*.foo.com"]);
  assert.deepEqual(parseHosts(undefined), []);
});

// ===== 网络读取（dsh read）=====

test("read 子命令解析 URL 与三个开关", () => {
  const cmd = parseArgv(["read", "https://example.com/", "--raw", "--full", "--max-bytes", "2048"]);
  assert.equal(cmd.kind, "read");
  if (cmd.kind !== "read") return;
  assert.equal(cmd.url, "https://example.com/");
  assert.equal(cmd.raw, true);
  assert.equal(cmd.full, true);
  assert.equal(cmd.maxBytes, 2048);
});

test("read 缺 URL 或给多个位置参数都报用法错误", () => {
  assert.throws(() => parseArgv(["read"]), UsageError);
  assert.throws(() => parseArgv(["read", "https://a.com", "https://b.com"]), UsageError);
});

test("htmlToText 丢脚本样式、块级断行、解实体", () => {
  const html = [
    "<html><head><title>标题 &amp; 副题</title><style>body{color:red}</style></head>",
    "<body><h1>大标题</h1><script>var leak = 1;</script>",
    "<p>第一段&nbsp;文字</p><p>第二段</p></body></html>",
  ].join("");
  const text = htmlToText(html);
  assert.ok(!text.includes("var leak"), "脚本内容必须丢掉");
  assert.ok(!text.includes("color:red"), "样式内容必须丢掉");
  assert.ok(text.includes("大标题"));
  assert.ok(text.includes("第一段 文字"), "&nbsp; 应还原成空格");
  assert.ok(text.split("\n").includes("第二段"), "块级标签应断行");
  assert.equal(extractTitle(html), "标题 & 副题");
});

test("readUrl 与 agent 走同一个 fetch_url，并解析出正文", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("<title>Hi</title><p>hello world</p>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    })) as typeof fetch;
  try {
    const r = await readUrl({ url: "https://example.com/" });
    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    assert.equal(r.title, "Hi");
    assert.ok(r.body.includes("hello world"));
  } finally {
    globalThis.fetch = original;
  }
});

test("readUrl 同样受主机白名单约束", async () => {
  const r = await readUrl({ url: "https://example.com/", hosts: ["other.com"] });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /白名单/);
});

test("readUrl 能通过真实 socket 读一个 http 页面（只走回环）", async () => {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end("<title>loopback</title><p>read works</p>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const r = await readUrl({ url: `http://127.0.0.1:${port}/` });
    assert.equal(r.status, 200);
    assert.equal(r.title, "loopback");
    assert.ok(r.body.includes("read works"));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("formatRead 默认截断正文，--full 时给全部", () => {
  const body = "x".repeat(5000);
  const result = {
    ok: true,
    url: "https://example.com/",
    status: 200,
    contentType: "text/html",
    bytes: 5000,
    truncated: false,
    elapsedMs: 1,
    title: "t",
    body,
  };
  const brief = formatRead(result).join("\n");
  const full = formatRead(result, { full: true }).join("\n");
  assert.ok(brief.includes("--full"), "截断时应提示怎么看全文");
  assert.ok(brief.length < full.length);
});

// ===== 配置优先级 =====

test("配置优先级：命令行 > DSH_* > DEEPSEEK_* > 默认", () => {
  const env = { DSH_API_KEY: "k-dsh", DEEPSEEK_API_KEY: "k-ds", DEEPSEEK_MODEL: "deepseek-reasoner", DSH_MODE: "" };
  const config = resolveConfig({ hosts: [], json: false, quiet: false }, env);
  assert.equal(config.apiKey, "k-dsh");
  assert.equal(config.model, "deepseek-reasoner");
  assert.equal(config.baseUrl, "https://api.deepseek.com");
  assert.deepEqual(config.tools, ["web_search", "fetch_url", "extract_links", "save_markdown"]);

  const overridden = resolveConfig({ hosts: [], json: false, quiet: false, model: "cli-model" }, env);
  assert.equal(overridden.model, "cli-model");
});

test("只设 DASHSCOPE_API_KEY 时自动推导端点与模型", () => {
  const config = resolveConfig({ hosts: [], json: false, quiet: false }, { DASHSCOPE_API_KEY: "sk-dash" });
  assert.equal(config.apiKey, "sk-dash");
  assert.equal(config.baseUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1");
  assert.equal(config.model, "qwen3.6-flash");

  // 显式指定仍然最高优先级
  const explicit = resolveConfig(
    { hosts: [], json: false, quiet: false, model: "qwen-max", baseUrl: "https://my-proxy/v1" },
    { DASHSCOPE_API_KEY: "sk-dash" },
  );
  assert.equal(explicit.model, "qwen-max");
  assert.equal(explicit.baseUrl, "https://my-proxy/v1");
});

test("多个密钥并存时 DASHSCOPE 兜底，不抢已有 provider 的默认值", () => {
  const dashOnly = resolveConfig({ hosts: [], json: false, quiet: false }, { DASHSCOPE_API_KEY: "sk-dash" });
  assert.equal(dashOnly.model, "qwen3.6-flash");

  const withDeepseek = resolveConfig(
    { hosts: [], json: false, quiet: false },
    { DASHSCOPE_API_KEY: "sk-dash", DEEPSEEK_API_KEY: "sk-ds" },
  );
  assert.equal(withDeepseek.apiKey, "sk-ds");
  assert.equal(withDeepseek.baseUrl, "https://api.deepseek.com");
  assert.equal(withDeepseek.model, "deepseek-chat");

  const withDsh = resolveConfig(
    { hosts: [], json: false, quiet: false },
    { DASHSCOPE_API_KEY: "sk-dash", DSH_API_KEY: "sk-dsh" },
  );
  assert.equal(withDsh.apiKey, "sk-dsh");
  assert.equal(withDsh.model, "deepseek-chat");
});

// ===== 交互会话 =====

function fakeIO(lines: string[]) {
  const out: string[] = [];
  let i = 0;
  return {
    out,
    io: {
      async ask(): Promise<string | null> {
        return i < lines.length ? lines[i++]! : null;
      },
      print(line = ""): void {
        out.push(line);
      },
    },
  };
}

function chatDeps(llm: ScriptedLLM, lines: string[]) {
  const fake = fakeIO(lines);
  return {
    fake,
    options: {
      llm,
      tools: [],
      scope: new Scope({ maxTurns: 2, maxToolCalls: 2 }),
      role: "测试助手",
      io: fake.io,
    },
  };
}

test("交互模式复用同一会话：第二轮能看到第一轮的问与答", async () => {
  const seen: string[][] = [];
  const llm = new ScriptedLLM([
    (req: ChatRequest) => {
      seen.push(req.messages.map((m) => `${m.role}:${m.content}`));
      return say("第一次回答");
    },
    (req: ChatRequest) => {
      seen.push(req.messages.map((m) => `${m.role}:${m.content}`));
      return say("第二次回答");
    },
  ]);
  const { options } = chatDeps(llm, ["第一问", "第二问"]);

  const outcome = await runChat(options);

  assert.equal(outcome.tasks, 2);
  assert.equal(outcome.reason, "eof");
  assert.equal(seen.length, 2);
  assert.ok(seen[1]!.includes("user:第一问"), "第二轮应带上第一轮的问题");
  assert.ok(seen[1]!.includes("assistant:第一次回答"), "第二轮应带上第一轮的回答");
  assert.ok(seen[1]!.includes("user:第二问"));
});

test("/reset 清空上下文，/exit 退出且不再调用模型", async () => {
  const seen: string[][] = [];
  const llm = new ScriptedLLM([
    (req: ChatRequest) => {
      seen.push(req.messages.map((m) => m.role));
      return say("答一");
    },
    (req: ChatRequest) => {
      seen.push(req.messages.map((m) => m.role));
      return say("答二");
    },
  ]);
  const { options, fake } = chatDeps(llm, ["问题一", "/reset", "问题二", "/exit"]);

  const outcome = await runChat(options);

  assert.equal(outcome.reason, "exit");
  assert.equal(outcome.tasks, 2);
  // 重置后的请求里只有 system + user
  assert.deepEqual(seen[1], ["system", "user"]);
  assert.ok(fake.out.some((l) => l.includes("已清空上下文")));
  assert.ok(fake.out.some((l) => l === "bye"));
});

test("/help 与未知命令都有反馈，空行被忽略", async () => {
  const llm = new ScriptedLLM([say("ok")]);
  const { options, fake } = chatDeps(llm, ["", "   ", "/help", "/nope", "/exit"]);

  await runChat(options);

  const text = fake.out.join("\n");
  assert.match(text, /\/exit/);
  assert.match(text, /未知命令 \/nope/);
  assert.equal(llm.calls, 0);
});

// ===== prompt 模式 =====

test("prompt 模式一次任务一个会话，JSON 结构稳定", async () => {
  const outcome = await runPromptTask("你好", {
    llm: new ScriptedLLM([say("你好，我是测试助手")]),
    tools: [],
    scope: new Scope({ maxTurns: 2, maxToolCalls: 2 }),
    role: "测试助手",
    io: { print: () => {} },
  });

  assert.equal(outcome.result.status, "completed");
  const json = JSON.parse(toJson(outcome)) as Record<string, unknown>;
  assert.equal(json.status, "completed");
  assert.equal(json.text, "你好，我是测试助手");
  assert.equal(json.turns, 1);
  assert.equal(typeof json.sessionId, "string");
});

// ===== doctor =====

const okFetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes("/models")) {
    return new Response(JSON.stringify({ data: [{ id: "a" }, { id: "b" }] }), {
      headers: { "content-type": "application/json" },
    });
  }
  return new Response("<html>ok</html>", { headers: { "content-type": "text/html" } });
}) as typeof fetch;

test("doctor：没有密钥时只警告，不判定失败", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "dsh-doctor-"));
  const report = await runDoctor({ env: {}, cwd, fetchImpl: okFetch, sshConfigPath: join(cwd, "no-config") });

  const key = report.checks.find((c) => c.name === "模型密钥");
  assert.equal(key?.status, "warn");
  assert.equal(report.failed, 0);
  assert.equal(report.ok, true);
});

test("doctor：有密钥且端点可用时全部通过，能报出模型数量", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "dsh-doctor-"));
  const cfg = join(cwd, "config");
  await writeFile(cfg, "Host 4090\n  HostName 10.0.0.2\nHost node03 *.wild\n", "utf8");

  const report = await runDoctor({
    env: { DSH_API_KEY: "sk-1234567890abcdef" },
    cwd,
    fetchImpl: okFetch,
    sshConfigPath: cfg,
  });

  const endpoint = report.checks.find((c) => c.name === "模型端点");
  assert.equal(endpoint?.status, "ok");
  assert.match(endpoint!.detail, /2 个可用模型/);

  const ssh = report.checks.find((c) => c.name === "SSH 主机");
  assert.match(ssh!.detail, /4090/);
  assert.doesNotMatch(ssh!.detail, /wild/);
  assert.equal(report.ok, true);
});

test("doctor：密钥被拒绝判为失败，退出码非 0", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "dsh-doctor-"));
  const deny = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;

  const report = await runDoctor({
    env: { DSH_API_KEY: "sk-bad-key-000000" },
    cwd,
    fetchImpl: deny,
    sshConfigPath: join(cwd, "none"),
  });

  assert.equal(report.failed, 1);
  assert.equal(report.ok, false);
  const endpoint = report.checks.find((c) => c.name === "模型端点");
  assert.match(endpoint!.detail, /401/);
});

test("parseSshHosts 跳过通配符与否定写法", () => {
  const hosts = parseSshHosts(`
Host 4090
  HostName 10.0.0.2
Host node03 node04
Host *.wild !bad
Host *
`);
  assert.deepEqual(hosts, ["4090", "node03", "node04"]);
});

// ===== remote =====

test("远端命令按参数整体引用，不会把任务文本拆成 shell 命令", () => {
  assert.equal(shellQuote("hello"), "hello");
  assert.equal(shellQuote("a b"), "'a b'");
  assert.equal(shellQuote("it's"), `'it'\\''s'`);

  const cmd = buildRemoteCommand(
    { kind: "prompt", task: "查看 GPU 状态; rm -rf /" },
    { bin: "dsh", hosts: ["node03"], maxTurns: 3 },
  );
  assert.equal(cmd, `dsh prompt '查看 GPU 状态; rm -rf /' --allow-host node03 --max-turns 3`);

  assert.deepEqual(buildSshArgv("4090", "dsh", { interactive: true }), ["ssh", "-t", "--", "4090", "dsh"]);
  assert.deepEqual(buildSshArgv("4090", "dsh prompt hi"), ["ssh", "--", "4090", "dsh prompt hi"]);
});

// ===== 主入口分派 =====

test("main：help 返回 0；缺密钥的 prompt 返回 2 并给出提示", async () => {
  const helpOut: string[] = [];
  const helpCode = await main(["help"], { env: {}, io: { out: (l = "") => helpOut.push(l), err: () => {} } });
  assert.equal(helpCode, 0);
  assert.match(helpOut.join("\n"), /dsh prompt/);

  const errOut: string[] = [];
  const code = await main(["prompt", "随便跑个任务"], {
    env: {},
    io: { out: () => {}, err: (l) => errOut.push(l) },
  });
  assert.equal(code, 2);
  assert.match(errOut.join("\n"), /缺少模型密钥/);

  const usageErr: string[] = [];
  const usageCode = await main(["bogus"], { env: {}, io: { out: () => {}, err: (l) => usageErr.push(l) } });
  assert.equal(usageCode, 2);
  assert.match(usageErr.join("\n"), /未知子命令/);
});

// ===== web_search =====

const SEARCH_HTML = `
<div class="result results_links">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1&amp;rut=abc">标题 &amp; 一</a>
  <a class="result__snippet" href="x">摘要一 <b>高亮</b></a>
</div>
<div class="result results_links">
  <a rel="nofollow" class="result__a" href="https://b.test/doc">第二条</a>
  <a class="result__snippet">摘要二</a>
</div>
`;

test("web_search 解析搜索页：还原真实 URL、去标签、配对摘要", () => {
  const hits = parseDuckDuckGoHtml(SEARCH_HTML, 8);
  assert.equal(hits.length, 2);
  assert.deepEqual(hits[0], { title: "标题 & 一", url: "https://example.com/a?x=1", snippet: "摘要一 高亮" });
  assert.equal(hits[1]!.url, "https://b.test/doc");
  assert.equal(hits[1]!.snippet, "摘要二");
});

test("web_search 工具返回结构化结果，且受工具白名单约束", async () => {
  const tool = createWebSearchTool({
    endpoint: "https://search.test/html/",
    fetchImpl: (async () => new Response(SEARCH_HTML, { headers: { "content-type": "text/html" } })) as typeof fetch,
  });
  const registry = new ToolRegistry().register(tool);
  const scope = new Scope({ allowedTools: ["web_search"] });

  const ok = await registry.invoke({ id: "c1", name: "web_search", args: { query: "agent" } }, { scope, sessionId: "s", logger: () => {} });
  assert.equal(ok.isError, false);
  const payload = JSON.parse(ok.content) as { count: number; results: Array<{ url: string }> };
  assert.equal(payload.count, 2);
  assert.equal(payload.results[0]!.url, "https://example.com/a?x=1");

  const denied = await registry.invoke(
    { id: "c2", name: "web_search", args: { query: "agent" } },
    { scope: new Scope({ allowedTools: ["fetch_url"] }), sessionId: "s", logger: () => {} },
  );
  assert.equal(denied.isError, true);
  assert.match(denied.content, /不在白名单/);
});

test("web_search 遇到非 2xx 或空结果时返回可读错误", async () => {
  const failing = createWebSearchTool({
    fetchImpl: (async () => new Response("blocked", { status: 429 })) as typeof fetch,
  });
  const registry = new ToolRegistry().register(failing);
  const scope = new Scope({ allowedTools: ["web_search"] });

  const msg = await registry.invoke({ id: "c1", name: "web_search", args: { query: "x" } }, { scope, sessionId: "s", logger: () => {} });
  assert.equal(msg.isError, true);
  assert.match(msg.content, /429/);
});

test("web_search 能解析必应结构，并还原 /ck/a 跳转链接", () => {
  const b64 = Buffer.from("https://real.test/path?a=1", "utf8").toString("base64url");
  const html = `
<ol id="b_results">
  <li class="b_algo"><h2><a target="_blank" href="https://nvidia.test/4090">RTX <strong>4090</strong> 规格</a></h2>
    <div class="b_caption"><p class="b_lineclamp2">24GB 显存 &amp; 450W 功耗</p></div></li>
  <li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=a1${b64}&amp;ntb=1">跳转结果</a></h2>
    <div class="b_caption"><p class="b_lineclamp4 b_algoSlug">摘要二</p></div></li>
</ol>`;
  const hits = parseSearchHtml(html, 5);
  assert.equal(hits.length, 2);
  assert.deepEqual(hits[0], { title: "RTX 4090 规格", url: "https://nvidia.test/4090", snippet: "24GB 显存 & 450W 功耗" });
  assert.equal(hits[1]!.url, "https://real.test/path?a=1");
  assert.equal(hits[1]!.snippet, "摘要二");
});

test("createToolset 拒绝未知工具名并列出可选值", () => {
  assert.throws(() => createToolset(["nope"]), /未知工具 nope/);
  assert.equal(createToolset(["fetch_url", "web_search"]).length, 2);
});
