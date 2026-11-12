import assert from "node:assert/strict";
import { after, test } from "node:test";
import { OpenAICompatibleClient, Scope, ScriptedLLM, Session, ToolRegistry, runAgent, runAgentLoop, say, webTools } from "../src";
import type { ChatRequest, LLMClient, ToolDefinition } from "../src";
import { startMockSite, type MockSite } from "../examples/mock-site";

let site: MockSite | undefined;

after(async () => {
  await site?.close();
});

async function getSite(): Promise<MockSite> {
  if (!site) site = await startMockSite();
  return site;
}

function baseScope(overrides: Partial<ConstructorParameters<typeof Scope>[0]> = {}): Scope {
  return new Scope({ maxTurns: 4, maxToolCalls: 4, maxOutputChars: 2000, toolTimeoutMs: 500, ...overrides });
}

function echoTool(seen?: string[]): ToolDefinition {
  return {
    name: "echo",
    description: "原样返回输入",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    run(input) {
      seen?.push(String(input.text));
      return { content: `echo:${String(input.text)}` };
    },
  };
}

function callTool(id: string, name: string, args: Record<string, unknown>) {
  return { role: "assistant" as const, content: "", toolCalls: [{ id, name, args }] };
}

test("没有工具调用时，loop 一轮结束并返回文本", async () => {
  const session = new Session();
  const registry = new ToolRegistry().register(echoTool());
  const llm = new ScriptedLLM([say("直接回答")]);

  const result = await runAgentLoop({ llm, registry, session, scope: baseScope() });

  assert.equal(result.status, "completed");
  assert.equal(result.text, "直接回答");
  assert.equal(result.turns, 1);
  assert.equal(result.toolCalls, 0);
});

test("工具结果按 tool_call_id 回填，且顺序为 assistant → tool", async () => {
  const seen: string[] = [];
  const session = new Session();
  const registry = new ToolRegistry().register(echoTool(seen));
  const llm = new ScriptedLLM([() => callTool("call_1", "echo", { text: "hi" }), say("收到")]);

  const result = await runAgentLoop({ llm, registry, session, scope: baseScope() });

  assert.equal(result.status, "completed");
  assert.deepEqual(seen, ["hi"]);
  const roles = session.messages.map((m) => m.role);
  assert.deepEqual(roles, ["assistant", "tool", "assistant"]);
  const toolMsg = session.messages[1]!;
  assert.equal(toolMsg.role, "tool");
  if (toolMsg.role === "tool") {
    assert.equal(toolMsg.toolCallId, "call_1");
    assert.equal(toolMsg.isError, false);
  }
  assert.equal(result.turns, 2);
});

test("未知工具不会抛异常，而是回填 isError 并继续对话", async () => {
  const session = new Session();
  const registry = new ToolRegistry().register(echoTool());
  const llm = new ScriptedLLM([() => callTool("c1", "missing_tool", {}), say("换个方法")]);

  const result = await runAgentLoop({ llm, registry, session, scope: baseScope() });

  assert.equal(result.status, "completed");
  const toolMsg = session.messages.find((m) => m.role === "tool");
  assert.ok(toolMsg && toolMsg.role === "tool" && toolMsg.isError);
  assert.match(toolMsg!.role === "tool" ? toolMsg!.content : "", /未知工具/);
});

test("scope 白名单拒绝时工具根本不执行", async () => {
  const seen: string[] = [];
  const session = new Session();
  const registry = new ToolRegistry().register(echoTool(seen));
  const llm = new ScriptedLLM([() => callTool("c1", "echo", { text: "blocked" }), say("跳过")]);

  const result = await runAgentLoop({
    llm,
    registry,
    session,
    scope: baseScope({ allowedTools: ["fetch_url"] }),
  });

  assert.deepEqual(seen, []);
  const denied = session.events.find((e) => e.type === "tool.note" && e.data.event === "rejected");
  assert.ok(denied, "应记录一次 rejected 事件");
  const toolMsg = session.messages.find((m) => m.role === "tool");
  assert.ok(toolMsg && toolMsg.role === "tool" && toolMsg.isError);
  assert.match(toolMsg!.role === "tool" ? toolMsg!.content : "", /不在白名单/);
  assert.equal(result.status, "completed");
});

test("轮次用尽时返回 max_turns", async () => {
  const session = new Session();
  const registry = new ToolRegistry().register(echoTool());
  const llm: LLMClient = {
    name: "always-tool",
    async chat() {
      return callTool(`c${Date.now()}`, "echo", { text: "again" });
    },
  };

  const result = await runAgentLoop({ llm, registry, session, scope: baseScope({ maxTurns: 3, maxToolCalls: 99 }) });

  assert.equal(result.status, "max_turns");
  assert.equal(result.turns, 3);
  assert.equal(result.toolCalls, 3);
});

test("工具调用预算用尽时返回 tool_budget", async () => {
  const session = new Session();
  const registry = new ToolRegistry().register(echoTool());
  const llm: LLMClient = {
    name: "two-calls",
    async chat() {
      return {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: `a${Date.now()}`, name: "echo", args: { text: "1" } },
          { id: `b${Date.now()}`, name: "echo", args: { text: "2" } },
        ],
      };
    },
  };

  const result = await runAgentLoop({ llm, registry, session, scope: baseScope({ maxTurns: 5, maxToolCalls: 1 }) });

  assert.equal(result.status, "tool_budget");
  assert.equal(result.toolCalls, 1);
  const budget = session.messages.find((m) => m.role === "tool" && m.content.includes("[budget]"));
  assert.ok(budget, "应有一条预算用尽的 tool 消息");
});

test("非法 JSON 参数回填可读错误，不执行工具", async () => {
  const seen: string[] = [];
  const session = new Session();
  const registry = new ToolRegistry().register(echoTool(seen));
  const llm = new ScriptedLLM([
    () => ({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "bad", name: "echo", args: {}, rawArgs: '{"text": "oops"' }],
    }),
    say("好的"),
  ]);

  await runAgentLoop({ llm, registry, session, scope: baseScope() });

  assert.deepEqual(seen, []);
  const toolMsg = session.messages.find((m) => m.role === "tool");
  assert.match(toolMsg!.role === "tool" ? toolMsg!.content : "", /invalid-json/);
});

test("工具超时会被拦截并标记为错误", async () => {
  const session = new Session();
  const registry = new ToolRegistry().register({
    name: "hang",
    description: "永不返回",
    parameters: { type: "object", properties: {} },
    run: () => new Promise(() => {}),
  });
  const llm = new ScriptedLLM([() => callTool("c1", "hang", {}), say("超时了")]);

  const result = await runAgentLoop({ llm, registry, session, scope: baseScope({ toolTimeoutMs: 50 }) });

  assert.equal(result.status, "completed");
  const toolMsg = session.messages.find((m) => m.role === "tool");
  assert.ok(toolMsg && toolMsg.role === "tool" && toolMsg.isError);
  assert.match(toolMsg!.role === "tool" ? toolMsg!.content : "", /超过 50ms/);
});

test("session.fork 复制消息但互不影响", () => {
  const parent = new Session();
  parent.append({ role: "user", content: "原始问题" });
  const child = parent.fork("换一条抓取路径");

  child.append({ role: "assistant", content: "子分支的回答", toolCalls: [] });

  assert.equal(parent.messages.length, 1);
  assert.equal(child.messages.length, 2);
  assert.equal(child.parentId, parent.id);
  assert.ok(child.events.some((e) => e.type === "session.fork"));
});

test("runAgent 自动注入 system prompt，且能统计事件", async () => {
  const { result, session } = await runAgent("你好", {
    role: "测试助手",
    llm: new ScriptedLLM([say("ok")]),
    tools: [echoTool()],
    scope: baseScope(),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.text, "ok");
  const sys = session.messages[0]!;
  assert.equal(sys.role, "system");
  assert.match(sys.content, /可用工具/);
  assert.match(sys.content, /echo/);
  assert.ok(session.events.some((e) => e.type === "session.start"));
  assert.ok(session.events.some((e) => e.type === "user.message"));
});

test("fetch_url 拒绝白名单外主机，且不出网", async () => {
  const s = await getSite();
  const session = new Session();
  const registry = new ToolRegistry().register(...webTools);
  const scope = Scope.crawler([new URL(s.baseUrl).hostname]);

  const msg = await registry.invoke(
    { id: "c1", name: "fetch_url", args: { url: "https://example.com/" } },
    { scope, sessionId: session.id, logger: () => {} },
  );

  assert.equal(msg.isError, true);
  assert.match(msg.content, /不在抓取白名单/);
});

test("fetch_url 抓取首页成功，extract_links 能抽出站内链接", async () => {
  const s = await getSite();
  const session = new Session();
  const registry = new ToolRegistry().register(...webTools);
  const scope = Scope.crawler([new URL(s.baseUrl).hostname]);

  const fetched = await registry.invoke(
    { id: "c1", name: "fetch_url", args: { url: s.baseUrl } },
    { scope, sessionId: session.id, logger: () => {} },
  );
  assert.equal(fetched.isError, false);

  const payload = JSON.parse(fetched.content) as { html: string; status: number; bytes: number };
  assert.equal(payload.status, 200);
  assert.ok(payload.bytes > 0);

  const links = await registry.invoke(
    { id: "c2", name: "extract_links", args: { html: payload.html, baseUrl: s.baseUrl } },
    { scope, sessionId: session.id, logger: () => {} },
  );
  const parsed = JSON.parse(links.content) as { count: number; links: Array<{ url: string }> };
  assert.ok(parsed.count >= 3);
  assert.ok(parsed.links.every((l) => l.url.startsWith(s.baseUrl)));
});

test("extract_links 能补全相对路径并跳过 javascript: 伪协议", () => {
  const tool = webTools.find((t) => t.name === "extract_links")!;
  const html = `
    <a href="/a">A</a>
    <a href="b.html">B</a>
    <a href="javascript:void(0)">JS</a>
    <a href="/a">A-dup</a>`;
  const out = tool.run({ html, baseUrl: "https://example.com/dir/" }, {} as never) as { content: string };
  const parsed = JSON.parse(out.content) as { count: number; links: Array<{ url: string }> };
  assert.equal(parsed.count, 2);
  assert.ok(parsed.links.some((l) => l.url === "https://example.com/a"));
  assert.ok(parsed.links.some((l) => l.url === "https://example.com/dir/b.html"));
});

test("工具输出超过 maxOutputChars 会被截断", async () => {
  const session = new Session();
  const registry = new ToolRegistry().register({
    name: "big",
    description: "返回大数据",
    parameters: { type: "object", properties: {} },
    run: () => ({ content: "x".repeat(500) }),
  });
  const scope = baseScope({ maxOutputChars: 100 });

  const msg = await registry.invoke(
    { id: "c1", name: "big", args: {} },
    { scope, sessionId: session.id, logger: () => {} },
  );

  assert.ok(msg.content.length < 200);
  assert.match(msg.content, /已截断/);
});

test("ScriptedLLM 的请求里能拿到完整消息流", async () => {
  const seen: string[] = [];
  const session = new Session();
  session.append({ role: "user", content: "抓取首页" });
  const registry = new ToolRegistry();
  const llm = new ScriptedLLM([
    (req: ChatRequest) => {
      seen.push(req.messages.map((m) => m.role).join(">"));
      return say("done");
    },
  ]);
  await runAgentLoop({ llm, registry, session, scope: baseScope() });
  assert.deepEqual(seen, ["user"]);
});

// ===== 真实模型适配器：注入 fetch 做离线验证，全程不发外网 =====

function wireResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function toolCallReply(argumentsText: string): Response {
  return wireResponse({
    choices: [
      {
        message: {
          content: "",
          tool_calls: [{ id: "c1", type: "function", function: { name: "echo", arguments: argumentsText } }],
        },
      },
    ],
  });
}

test("OpenAICompatibleClient 端点拼接正确，并能解析 tool_calls 与 usage", async () => {
  let seenUrl = "";
  const client = new OpenAICompatibleClient({
    apiKey: "test-key",
    baseUrl: "https://api.example.test/v1/",
    fetchImpl: async (url) => {
      seenUrl = String(url);
      return wireResponse({
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                { id: "c1", type: "function", function: { name: "echo", arguments: '{"text":"hi"}' } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    },
  });

  const msg = await client.chat({ messages: [], tools: [] });

  assert.equal(seenUrl, "https://api.example.test/v1/chat/completions");
  assert.equal(msg.toolCalls.length, 1);
  assert.equal(msg.toolCalls[0]!.name, "echo");
  assert.deepEqual(msg.toolCalls[0]!.args, { text: "hi" });
  assert.equal(msg.usage?.totalTokens, 15);
});

test("模型给出数组形式的 arguments 时不会被当成参数对象", async () => {
  const client = new OpenAICompatibleClient({
    apiKey: "test-key",
    fetchImpl: async () => toolCallReply("[1,2]"),
  });

  const msg = await client.chat({ messages: [], tools: [] });

  assert.equal(Array.isArray(msg.toolCalls[0]!.args), false);
  assert.deepEqual(msg.toolCalls[0]!.args, {});
});

test("模型给出非法 JSON 参数时保留原文，交给 loop 回填可读错误", async () => {
  const client = new OpenAICompatibleClient({
    apiKey: "test-key",
    fetchImpl: async () => toolCallReply('{"text": "oops"'),
  });

  const msg = await client.chat({ messages: [], tools: [] });

  assert.equal(msg.toolCalls[0]!.rawArgs, '{"text": "oops"');
});

test("LLM 返回非 2xx 时错误里带上状态码与响应体", async () => {
  const client = new OpenAICompatibleClient({
    apiKey: "test-key",
    fetchImpl: async () =>
      wireResponse("rate limited", { status: 429, statusText: "Too Many Requests" }),
  });

  await assert.rejects(() => client.chat({ messages: [], tools: [] }), /429.*rate limited/);
});
