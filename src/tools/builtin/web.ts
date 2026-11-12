/**
 * 爬虫场景的三个基础工具。
 * 刻意做小：抓页面、抽链接、落盘。复杂能力（渲染、分页、去重）
 * 应该在 agent 层组合，而不是继续往内核的工具里堆。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { ToolDefinition } from "../types";

const USER_AGENT = "agent-harness/0.1 (+crawler agent)";
const MAX_BYTES = 512 * 1024;

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string" || v.trim() === "") throw new Error(`参数 ${key} 必须是非空字符串`);
  return v.trim();
}

function num(input: Record<string, unknown>, key: string, fallback: number): number {
  const v = input[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** 抓取一个 URL，返回 JSON 字符串（状态码 / 体积 / 正文） */
export const fetchUrlTool: ToolDefinition = {
  name: "fetch_url",
  description:
    "抓取一个 http/https 页面，返回 JSON：{url,status,contentType,bytes,truncated,html}。" +
    "只能访问作用域白名单内的主机；重定向后的最终主机同样受白名单约束。",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "绝对 URL，例如 https://example.com/" },
      maxBytes: { type: "number", description: "回填给模型的正文最大字节数，超出会截断，默认 524288" },
    },
    required: ["url"],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const rawUrl = str(input, "url");
    const verdict = ctx.scope.canFetchUrl(rawUrl);
    if (!verdict.allowed) return { content: `[scope] ${verdict.reason}`, isError: true };

    const limit = Math.min(num(input, "maxBytes", MAX_BYTES), MAX_BYTES);
    const started = Date.now();
    const resp = await fetch(rawUrl, {
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
      signal: ctx.signal,
      redirect: "follow",
    });

    // 关键防御：跳转后的主机也必须过白名单，否则 302 就能绕过 scope
    const finalUrl = new URL(resp.url || rawUrl);
    const finalVerdict = ctx.scope.canFetchUrl(finalUrl.toString());
    if (!finalVerdict.allowed) {
      return { content: `[scope] 重定向到 ${finalUrl.hostname} 被拒绝：${finalVerdict.reason}`, isError: true };
    }

    const buf = Buffer.from(await resp.arrayBuffer());
    const truncated = buf.byteLength > limit;
    const body = (truncated ? buf.subarray(0, limit) : buf).toString("utf8");

    ctx.logger("fetch.done", {
      url: finalUrl.toString(),
      status: resp.status,
      bytes: buf.byteLength,
      ms: Date.now() - started,
    });

    return {
      content: JSON.stringify({
        url: finalUrl.toString(),
        status: resp.status,
        contentType: resp.headers.get("content-type") ?? "",
        bytes: buf.byteLength,
        truncated,
        html: body,
      }),
      isError: !resp.ok,
    };
  },
};

/** 从 HTML 里抽 http(s) 链接，相对路径按 baseUrl 补全 */
export const extractLinksTool: ToolDefinition = {
  name: "extract_links",
  description: "从 HTML 文本中抽取 a[href] 链接，返回 JSON 数组：{text,url,host}。相对路径会按 baseUrl 补全。",
  parameters: {
    type: "object",
    properties: {
      html: { type: "string", description: "页面 HTML 原文" },
      baseUrl: { type: "string", description: "用于补全相对路径的基准 URL" },
      limit: { type: "number", description: "最多返回多少条，默认 20" },
    },
    required: ["html", "baseUrl"],
    additionalProperties: false,
  },
  run(input) {
    const html = str(input, "html");
    const base = str(input, "baseUrl");
    const limit = Math.min(num(input, "limit", 20), 100);
    const seen = new Set<string>();
    const out: Array<{ text: string; url: string; host: string }> = [];

    const re = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null && out.length < limit) {
      const href = m[1]!.trim();
      if (/^(javascript:|mailto:|tel:)/i.test(href)) continue;
      let abs: URL;
      try {
        abs = new URL(href, base);
      } catch {
        continue;
      }
      if (abs.protocol !== "http:" && abs.protocol !== "https:") continue;
      const key = abs.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ text: stripTags(m[2]!).slice(0, 80), url: key, host: abs.hostname });
    }

    return { content: JSON.stringify({ count: out.length, links: out }) };
  },
};

/** 把整理好的 Markdown 写进 out/ 目录（限制在 rootDir 内，防目录穿越） */
export const saveMarkdownTool: ToolDefinition = {
  name: "save_markdown",
  description: "把 Markdown 文本保存到工作目录的 out/ 下，返回写入字节数与绝对路径。",
  parameters: {
    type: "object",
    properties: {
      filename: { type: "string", description: "文件名，例如 report.md" },
      content: { type: "string", description: "Markdown 正文" },
    },
    required: ["filename", "content"],
    additionalProperties: false,
  },
  async run(input) {
    const filename = str(input, "filename");
    const content = str(input, "content");
    const root = resolve(process.cwd(), "out");
    const target = resolve(root, filename);
    if (target !== root && !target.startsWith(root + sep)) {
      return { content: `[scope] 拒绝写入 ${target}：只能写入 out/ 目录`, isError: true };
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
    return {
      content: JSON.stringify({ path: target, bytes: Buffer.byteLength(content, "utf8") }),
    };
  },
};

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

export const webTools: ToolDefinition[] = [fetchUrlTool, extractLinksTool, saveMarkdownTool];
