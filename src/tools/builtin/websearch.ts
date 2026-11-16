/**
 * web_search：给 agent 一个"先搜再抓"的入口。
 *
 * 为什么需要它：crawler 的 fetch_url 只能抓已知 URL。要回答"帮我查 X 的最新资料"
 * 这类任务，模型必须先拿到候选链接，否则只能瞎猜域名。
 *
 * 与 scope 的关系（重要）：
 *   - 搜索请求固定发往**配置的搜索端点**，URL 不由模型控制，因此不走抓取主机白名单；
 *   - 但工具本身仍受 scope 的工具白名单约束（不想让它联网就把 web_search 从 allowedTools 里去掉）；
 *   - 搜索结果里的真实页面依旧要用 fetch_url 抓，那一步照常受主机白名单限制。
 *
 * 后端：默认必应（国内可直连），可用 DSH_SEARCH_ENDPOINT 换成 DuckDuckGo / SearXNG 等。
 * 解析器按页面特征自动识别，所以换端点通常不用改代码。
 * 零依赖：请求搜索页 HTML，再用正则抽标题 / 链接 / 摘要。
 */
import type { ToolDefinition, ToolResult } from "../types";
import { clampNumber, readNumber, readString, stripTags } from "./params";

/** 默认必应：实测在无外网的国内环境仍可直连（会 302 到 cn.bing.com） */
export const DEFAULT_SEARCH_ENDPOINT = "https://www.bing.com/search";
/** DuckDuckGo html 轻量版：结构更干净，但部分网络环境不可达 */
export const DUCKDUCKGO_ENDPOINT = "https://html.duckduckgo.com/html/";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchOptions {
  /** 搜索页地址；默认取 DSH_SEARCH_ENDPOINT，再退到必应 */
  endpoint?: string;
  /** 便于测试注入；默认用全局 fetch */
  fetchImpl?: typeof fetch;
  userAgent?: string;
  /** 自定义解析器：换搜索引擎时只换这一层 */
  parse?: (html: string, limit: number) => SearchHit[];
}

/**
 * 按页面特征自动选解析器：
 *   必应 -> <li class="b_algo"><h2><a href>标题</a>…
 *   DDG  -> <a class="result__a" href="//duckduckgo.com/l/?uddg=…">
 * 两个都认不出来就返回空数组，由工具层给出"可能被反爬"的可读错误。
 */
export function parseSearchHtml(html: string, limit = 8): SearchHit[] {
  if (/class="[^"]*\bb_algo\b/.test(html)) return parseBingHtml(html, limit);
  return parseDuckDuckGoHtml(html, limit);
}

/** 解析必应结果页：标题在 h2>a，摘要在 <p class="b_lineclamp…"> */
export function parseBingHtml(html: string, limit = 8): SearchHit[] {
  const anchorRe = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<p\b[^>]*class="[^"]*\bb_(?:lineclamp|algoSlug)\w*[^"]*"[^>]*>([\s\S]*?)<\/p>/gi;

  const anchors: Array<{ title: string; url: string; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) !== null) {
    const url = decodeBingHref(m[1]!);
    const title = stripTags(m[2]!);
    if (!url || !title) continue;
    anchors.push({ title, url, end: anchorRe.lastIndex });
  }

  const snippets: Array<{ text: string; start: number }> = [];
  while ((m = snippetRe.exec(html)) !== null) {
    snippets.push({ text: stripTags(m[1]!), start: m.index });
  }

  return pair(anchors, snippets, limit);
}

/**
 * 解析 DuckDuckGo html 版结果页。
 * 结构：<a class="result__a" href="//duckduckgo.com/l/?uddg=<encoded>">标题</a>
 *       <a class="result__snippet">摘要</a>
 */
export function parseDuckDuckGoHtml(html: string, limit = 8): SearchHit[] {
  const anchorRe = /<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/gi;

  const anchors: Array<{ title: string; url: string; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) !== null) {
    const url = decodeDuckDuckGoHref(m[1]!);
    const title = stripTags(m[2]!);
    if (!url || !title) continue;
    anchors.push({ title, url, end: anchorRe.lastIndex });
  }

  const snippets: Array<{ text: string; start: number }> = [];
  while ((m = snippetRe.exec(html)) !== null) {
    snippets.push({ text: stripTags(m[1]!), start: m.index });
  }

  return pair(anchors, snippets, limit);
}

/** 摘要按文档顺序与锚点配对，缺摘要的条目允许 snippet 为空串 */
function pair(
  anchors: Array<{ title: string; url: string; end: number }>,
  snippets: Array<{ text: string; start: number }>,
  limit: number,
): SearchHit[] {
  const hits: SearchHit[] = [];
  let si = 0;
  for (const a of anchors) {
    if (hits.length >= limit) break;
    while (si < snippets.length && snippets[si]!.start < a.end) si += 1;
    const snippet = si < snippets.length ? snippets[si++]!.text : "";
    hits.push({ title: a.title, url: a.url, snippet });
  }
  return hits;
}

/** DDG 把真实地址塞在 /l/?uddg= 参数里，这里解回原始 URL */
function decodeDuckDuckGoHref(raw: string): string | undefined {
  const cleaned = raw.trim().replace(/&amp;/g, "&");
  if (!cleaned) return undefined;
  try {
    const url = new URL(cleaned.startsWith("//") ? `https:${cleaned}` : cleaned, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    if (uddg) return uddg;
    if (url.hostname.endsWith("duckduckgo.com")) return undefined; // 广告 / 站内跳转
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/**
 * 必应部分结果走 /ck/a?u=a1<base64url> 跳转，需要还原成真实地址；
 * 还原不了就丢掉，绝不让模型拿到一个必应内部跳转链接去抓。
 */
function decodeBingHref(raw: string): string | undefined {
  const cleaned = raw.trim().replace(/&amp;/g, "&");
  if (!cleaned) return undefined;
  try {
    const url = new URL(cleaned, "https://www.bing.com");
    if (/bing\.com$/i.test(url.hostname) && url.pathname.startsWith("/ck/a")) {
      const encoded = url.searchParams.get("u");
      if (!encoded) return undefined;
      const payload = encoded.startsWith("a1") ? encoded.slice(2) : encoded;
      const decoded = Buffer.from(payload, "base64url").toString("utf8");
      return /^https?:\/\//i.test(decoded) ? decoded : undefined;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function createWebSearchTool(options: WebSearchOptions = {}): ToolDefinition {
  const endpoint = options.endpoint ?? process.env.DSH_SEARCH_ENDPOINT ?? DEFAULT_SEARCH_ENDPOINT;
  const fetchImpl = options.fetchImpl ?? fetch;
  const userAgent = options.userAgent ?? BROWSER_UA;
  const parse = options.parse ?? parseSearchHtml;

  return {
    name: "web_search",
    description:
      "用关键词搜索网页，返回 JSON：{query,count,results:[{title,url,snippet}]}。" +
      "只拿候选链接和摘要；要读正文请再用 fetch_url 抓具体 URL（那一步受主机白名单约束）。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词，2~200 字符" },
        limit: { type: "number", description: "返回条数，默认 8，最大 20" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async run(input, ctx): Promise<ToolResult> {
      const query = readString(input, "query").slice(0, 200);
      const limit = clampNumber(readNumber(input, "limit", 8), 1, 20);
      const started = Date.now();
      ctx.logger("search.start", { query, limit, endpoint });

      const target = `${endpoint}${endpoint.includes("?") ? "&" : "?"}q=${encodeURIComponent(query)}`;
      const resp = await fetchImpl(target, {
        method: "GET",
        headers: {
          "user-agent": userAgent,
          accept: "text/html,application/xhtml+xml",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
        signal: ctx.signal,
        redirect: "follow",
      });

      if (!resp.ok) {
        ctx.logger("search.done", { query, status: resp.status });
        return { content: `[search] ${endpoint} 返回 HTTP ${resp.status} ${resp.statusText}`, isError: true };
      }

      const html = await resp.text();
      const results = parse(html, limit);
      ctx.logger("search.done", { query, count: results.length, ms: Date.now() - started });

      if (results.length === 0) {
        return {
          content: JSON.stringify({
            query,
            endpoint,
            count: 0,
            results: [],
            note: "结果页没解析出条目：可能被反爬拦截，或关键词无结果。可换 DSH_SEARCH_ENDPOINT 再试。",
          }),
          isError: true,
        };
      }
      return { content: JSON.stringify({ query, endpoint, count: results.length, results }) };
    },
  };
}

/** 默认实例：端点取 DSH_SEARCH_ENDPOINT，未设置则用必应 */
export const webSearchTool: ToolDefinition = createWebSearchTool();
