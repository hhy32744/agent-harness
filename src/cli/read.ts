/**
 * `dsh read <url>`：把内核里的 fetch_url 直接暴露到命令行。
 *
 * 为什么单独做这条命令：agent 读网页要过大模型，没配 key 就演示不了。
 * 但"能不能读网页"是内核能力，和有没有 key 无关 —— 所以这里不搭一条旁路实现，
 * 而是走 ToolRegistry.invoke 调用**同一个** fetch_url，
 * 于是 scope 校验、超时、错误收敛的行为与 agent 完全一致，检查时看到的就是真身。
 */
import { Scope } from "../scope";
import { ToolRegistry } from "../tools/registry";
import { fetchUrlTool } from "../tools/builtin/web";
import { decodeEntities } from "../tools/builtin/params";

/** fetch_url 自己的硬上限，这里保持一致 */
const HARD_MAX_BYTES = 512 * 1024;
const DEFAULT_MAX_BYTES = 256 * 1024;
/** 终端默认打印的正文长度，--full 可取消 */
const DEFAULT_TEXT_LIMIT = 4000;

export interface ReadInput {
  url: string;
  /** 主机白名单；空数组/未填表示不限制 */
  hosts?: string[];
  maxBytes?: number;
  /** 保留原始 HTML，不做正文提取 */
  raw?: boolean;
  signal?: AbortSignal;
}

export interface ReadResult {
  ok: boolean;
  url: string;
  status: number;
  contentType: string;
  bytes: number;
  truncated: boolean;
  elapsedMs: number;
  title: string;
  /** 正文（raw 模式为原始 HTML） */
  body: string;
  /** 失败原因；ok 为 true 时不存在 */
  error?: string;
}

export async function readUrl(input: ReadInput): Promise<ReadResult> {
  const started = Date.now();
  const maxBytes = Math.min(input.maxBytes ?? DEFAULT_MAX_BYTES, HARD_MAX_BYTES);
  const hosts = input.hosts && input.hosts.length > 0 ? input.hosts : undefined;

  const scope = new Scope({
    allowedTools: ["fetch_url"],
    allowedHosts: hosts,
    // 正文要原样带回终端，别让内核的输出预算先切一刀
    maxOutputChars: maxBytes * 2 + 4096,
    toolTimeoutMs: 30000,
  });

  const registry = new ToolRegistry().register(fetchUrlTool);
  const msg = await registry.invoke(
    { id: "read-1", name: "fetch_url", args: { url: input.url, maxBytes } },
    { scope, sessionId: "read", signal: input.signal, logger: () => {} },
  );

  const base = {
    url: input.url,
    bytes: 0,
    truncated: false,
    elapsedMs: Date.now() - started,
    title: "",
    body: "",
  };

  // 工具永远返回字符串：可能是 JSON，也可能是 [scope] / [error] 开头的一行原因
  let payload: { url?: string; status?: number; contentType?: string; bytes?: number; truncated?: boolean; html?: string };
  try {
    payload = JSON.parse(msg.content);
  } catch {
    return { ...base, ok: false, status: 0, contentType: "", error: msg.content.trim() };
  }
  if (typeof payload?.html !== "string") {
    return { ...base, ok: false, status: 0, contentType: "", error: msg.content.trim() };
  }

  const html = payload.html;
  return {
    ok: (payload.status ?? 0) >= 200 && (payload.status ?? 0) < 300,
    url: payload.url ?? input.url,
    status: payload.status ?? 0,
    contentType: payload.contentType ?? "",
    bytes: payload.bytes ?? 0,
    truncated: Boolean(payload.truncated),
    elapsedMs: Date.now() - started,
    title: extractTitle(html),
    body: input.raw ? html : htmlToText(html),
  };
}

/** 取 <title>，顺手解实体、压空白 */
export function extractTitle(html: string): string {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  if (!m) return "";
  return decodeEntities(m[1]!)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * HTML → 纯文本。
 * 不做完整解析（那要引第三方库），只处理对"读网页"真正有影响的三件事：
 * 丢掉 script/style/注释、块级标签断行、解实体。
 */
export function htmlToText(html: string): string {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");

  const blocked = cleaned
    .replace(
      /<\/(p|div|section|article|aside|li|tr|h[1-6]|blockquote|pre|table|ul|ol|dl|dt|dd|header|footer|nav|figure)\s*>/gi,
      "\n",
    )
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(td|th)\s*>/gi, "\t")
    .replace(/<[^>]+>/g, " ");

  return decodeEntities(blocked)
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function formatRead(result: ReadResult, options: { full?: boolean } = {}): string[] {
  if (result.error) return [`读取失败：${result.error}`];

  const meta = [
    `${result.url}  →  ${result.status} ${result.contentType || "(无 content-type)"}`,
    `${formatBytes(result.bytes)} · ${result.elapsedMs}ms`,
  ];
  if (result.truncated) meta.push("已按 --max-bytes 截断");

  const lines = [meta.join(" | ")];
  if (result.title) lines.push(`标题：${result.title}`);
  lines.push("", "─".repeat(60), "");

  if (result.body === "") {
    lines.push("（正文为空）");
    return lines;
  }

  if (options.full || result.body.length <= DEFAULT_TEXT_LIMIT) {
    lines.push(result.body);
    return lines;
  }

  lines.push(result.body.slice(0, DEFAULT_TEXT_LIMIT));
  lines.push(
    "",
    `…（正文共 ${result.body.length} 字符，已显示前 ${DEFAULT_TEXT_LIMIT}；加 --full 看全部，--raw 看原始 HTML）`,
  );
  return lines;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
