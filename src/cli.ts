/**
 * 演示入口：一个"只用 core 拼出来"的爬虫 agent。
 *
 * 默认走离线脚本模型（不需要 API key、不发外网请求），完整跑一遍
 * LLM → 工具 → LLM 的闭环；加 --live 且设置 DEEPSEEK_API_KEY 后
 * 同一个 Agent 直接换成真实 DeepSeek 模型，代码一行不改。
 */
import { readFile } from "node:fs/promises";
import { OpenAICompatibleClient, Scope, ScriptedLLM, runAgent, say, webTools } from "./core";
import type { ChatRequest, LLMClient, SessionEvent } from "./core";
import { startMockSite } from "./demo/mock-site";

interface FetchPayload {
  url: string;
  status: number;
  bytes: number;
  html: string;
}

interface LinksPayload {
  count: number;
  links: Array<{ text: string; url: string; host: string }>;
}

/** 在消息流里倒序找第一条满足条件的 JSON 工具结果 */
function findToolPayload<T>(req: ChatRequest, pred: (v: unknown) => boolean): T | undefined {
  for (let i = req.messages.length - 1; i >= 0; i -= 1) {
    const msg = req.messages[i]!;
    if (msg.role !== "tool") continue;
    try {
      const parsed = JSON.parse(msg.content) as unknown;
      if (pred(parsed)) return parsed as T;
    } catch {
      // 被拒绝 / 报错的工具结果是纯文本，跳过
    }
  }
  return undefined;
}

function buildScript(baseUrl: string): ScriptedLLM {
  return new ScriptedLLM([
    // 第 1 轮：抓首页
    () => ({
      role: "assistant",
      content: "先抓首页，看看有哪些可用的入口链接。",
      toolCalls: [{ id: "call_fetch_home", name: "fetch_url", args: { url: baseUrl } }],
    }),
    // 第 2 轮：故意越界，验证 scope 真的能挡住
    () => ({
      role: "assistant",
      content: "顺手试试白名单外的站点，确认边界是否生效。",
      toolCalls: [{ id: "call_fetch_outside", name: "fetch_url", args: { url: "https://example.com/" } }],
    }),
    // 第 3 轮：从首页 HTML 抽链接
    (req) => {
      const home = findToolPayload<FetchPayload>(req, (v) => isFetch(v) && sameUrl(v.url, baseUrl));
      if (!home) return say("首页抓取失败，无法继续。");
      return {
        role: "assistant",
        content: "首页拿到了，抽出链接列表。",
        toolCalls: [
          { id: "call_extract_links", name: "extract_links", args: { html: home.html, baseUrl, limit: 5 } },
        ],
      };
    },
    // 第 4 轮：抓第一篇正文
    (req) => {
      const links = findToolPayload<LinksPayload>(req, (v) => isLinks(v));
      const first = links?.links.find((l) => l.url.includes("/article/"));
      if (!first) return say("没有找到文章链接。");
      return {
        role: "assistant",
        content: `抓取第一篇：${first.text}`,
        toolCalls: [{ id: "call_fetch_article", name: "fetch_url", args: { url: first.url } }],
      };
    },
    // 第 5 轮：把结果落盘
    (req) => {
      const article = findToolPayload<FetchPayload>(req, (v) => isFetch(v) && v.url.includes("/article/"));
      const links = findToolPayload<LinksPayload>(req, (v) => isLinks(v));
      if (!article) return say("正文没抓到，放弃落盘。");
      const title = /<title>([\s\S]*?)<\/title>/i.exec(article.html)?.[1]?.trim() ?? "(无标题)";
      const md = [
        `# ${title}`,
        "",
        `- 来源：${article.url}`,
        `- 状态：200，正文 ${article.bytes} 字节`,
        "",
        "## 首页发现的链接",
        ...(links?.links ?? []).map((l) => `- [${l.text}](${l.url})`),
        "",
        "> 由 agent-harness 自动抓取生成。",
      ].join("\n");
      return {
        role: "assistant",
        content: "整理成 Markdown 并保存。",
        toolCalls: [{ id: "call_save", name: "save_markdown", args: { filename: "crawl-report.md", content: md } }],
      };
    },
    // 第 6 轮：收尾（不再调用工具 → loop 退出）
    (req) => {
      const home = findToolPayload<FetchPayload>(req, (v) => isFetch(v) && sameUrl(v.url, baseUrl));
      const links = findToolPayload<LinksPayload>(req, (v) => isLinks(v));
      const saved = findToolPayload<{ path: string; bytes: number }>(req, (v) => isSaved(v));
      return say(
        [
          "任务完成。",
          `1) 抓取首页成功：${home?.bytes ?? 0} 字节；`,
          `2) 抽取到 ${links?.count ?? 0} 条站内链接；`,
          `3) 抓取正文并保存到 ${saved?.path ?? "(未保存)"}（${saved?.bytes ?? 0} 字节）；`,
          "4) 白名单外的 example.com 被 scope 拒绝，未发出请求。",
        ].join("\n"),
      );
    },
  ]);
}

function sameUrl(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

function isFetch(v: unknown): v is FetchPayload {
  return !!v && typeof v === "object" && "html" in v && "bytes" in v;
}
function isLinks(v: unknown): v is LinksPayload {
  return !!v && typeof v === "object" && "links" in v && Array.isArray((v as LinksPayload).links);
}
function isSaved(v: unknown): v is { path: string; bytes: number } {
  return !!v && typeof v === "object" && "path" in v && "bytes" in v;
}

function printEvent(event: SessionEvent, t0: number): void {
  const ms = String(Date.now() - t0).padStart(5, " ");
  const turn = event.turn ? `t${event.turn}` : "  ";
  switch (event.type) {
    case "session.start":
      console.log(`[${ms}ms] ${turn} session  start   agent=${event.data.agent} llm=${event.data.llm}`);
      console.log(`             tools=${(event.data.tools as string[]).join(",")}`);
      break;
    case "assistant.message": {
      const calls = event.data.toolCalls as number;
      console.log(`[${ms}ms] ${turn} assistant ${calls === 0 ? "final  " : `${calls} call(s)`} ${String(event.data.preview ?? "")}`);
      break;
    }
    case "tool.call":
      console.log(`[${ms}ms] ${turn} tool.call  ${String(event.data.name)} ${JSON.stringify(event.data.args).slice(0, 110)}`);
      break;
    case "tool.result":
      console.log(
        `[${ms}ms] ${turn} tool.done  ${String(event.data.name)} ${event.data.isError ? "ERROR" : "ok"} ${String(event.data.chars)} chars`,
      );
      break;
    case "tool.note":
      console.log(`[${ms}ms] ${turn}   · ${String(event.data.event)} ${JSON.stringify(event.data.detail)}`);
      break;
    case "turn.limit":
      console.log(`[${ms}ms] ${turn} limit      ${JSON.stringify(event.data)}`);
      break;
    case "session.end":
      console.log(`[${ms}ms] ${turn} session  end     status=${String(event.data.status)}`);
      break;
    case "error":
      console.log(`[${ms}ms] ${turn} error      ${String(event.data.message)}`);
      break;
    default:
      break;
  }
}

async function main(): Promise<void> {
  const live = process.argv.includes("--live");
  const task =
    "抓取实验室站点首页，列出入口链接，挑一篇正文抓下来，整理成 Markdown 保存到 out/ 目录，最后给出摘要。";

  const site = await startMockSite();
  const scope = Scope.crawler([new URL(site.baseUrl).hostname], { maxTurns: 8, maxToolCalls: 12 });
  const t0 = Date.now();

  const llm: LLMClient = live
    ? new OpenAICompatibleClient({
        apiKey: requireEnv("DEEPSEEK_API_KEY"),
        baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
        model: process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
      })
    : buildScript(site.baseUrl);

  console.log("=== agent-harness demo ===");
  console.log(`node ${process.version} | llm=${llm.name} | target=${site.baseUrl}`);
  console.log(`scope: tools=${scope.policy.allowedTools?.join(",")} hosts=${scope.policy.allowedHosts?.join(",")} maxTurns=${scope.policy.maxTurns}`);
  console.log(`task: ${task}`);
  console.log("");

  const { result, session } = await runAgent(task, {
    name: "crawler-demo",
    role: "网页信息抽取助手",
    llm,
    tools: webTools,
    scope,
    onEvent: (e) => printEvent(e, t0),
  });
  const elapsed = Date.now() - t0;

  console.log("");
  console.log("=== result ===");
  console.log(result.text);
  console.log("");
  console.log("--- 关键指标 ---");
  console.log(`status      : ${result.status}`);
  console.log(`turns       : ${result.turns}`);
  console.log(`tool calls  : ${result.toolCalls} (errors: ${session.snapshot().stats.toolErrors})`);
  console.log(`messages    : ${session.messages.length}`);
  console.log(`events      : ${session.events.length}`);
  console.log(`elapsed     : ${elapsed}ms`);
  if (result.usage.totalTokens > 0) {
    console.log(`tokens      : prompt=${result.usage.promptTokens} completion=${result.usage.completionTokens} total=${result.usage.totalTokens}`);
  }

  const saved = `${process.cwd()}/out/crawl-report.md`;
  try {
    const text = await readFile(saved, "utf8");
    console.log(`output      : ${saved} (${Buffer.byteLength(text)} 字节)`);
    console.log("--- out/crawl-report.md ---");
    console.log(text);
  } catch {
    console.log(`output      : ${saved} 未生成`);
  }

  await site.close();
  if (result.status !== "completed") process.exitCode = 1;
}

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`--live 模式需要环境变量 ${key}`);
  return v;
}

main().catch((err) => {
  console.error("demo 失败：", err);
  process.exitCode = 1;
});
