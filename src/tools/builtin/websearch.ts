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
 * 后端（provider）：
 *   - html（默认）：请求搜索页 HTML 再用正则抽取，零依赖；默认必应（国内可直连），
 *     可用 DSH_SEARCH_ENDPOINT 换成 DuckDuckGo / SearXNG 等，解析器按页面特征自动识别。
 *   - tavily：走 Tavily 的 JSON API，结果更稳但要 API key（DSH_TAVILY_KEY）。
 *     端点是固定的，不受 DSH_SEARCH_ENDPOINT 影响。
 */
import type { ToolDefinition, ToolResult } from "../types";
import { clampNumber, readNumber, readString, stripTags } from "./params";

/** 默认必应：实测在无外网的国内环境仍可直连（会 302 到 cn.bing.com） */
export const DEFAULT_SEARCH_ENDPOINT = "https://www.bing.com/search";
/** DuckDuckGo html 轻量版：结构更干净，但部分网络环境不可达 */
export const DUCKDUCKGO_ENDPOINT = "https://html.duckduckgo.com/html/";
/** Tavily 搜索 API：返回结构化 JSON，需要 key */
export const TAVILY_ENDPOINT = "https://api.tavily.com/search";

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
  /** 后端：html（默认，零依赖抓页面）或 tavily（JSON API，需 key） */
  provider?: "html" | "tavily";
  /** Tavily API key；不传则取 DSH_TAVILY_KEY */
  apiKey?: string;
  /** 便于测试注入；默认用全局 fetch */
  fetchImpl?: typeof fetch;
  userAgent?: string;
  /** 自定义解析器：换搜索引擎时只换这一层 */
  parse?: (html: string, limit: number) => SearchHit[];
}

/** Tavily 响应：{results:[{title,url,content,...}]}；把 content 当摘要 */
export function parseTavilyJson(json: unknown, limit: number): SearchHit[] {
  if (!json || typeof json !== "object") return [];
  const results = (json as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  const hits: SearchHit[] = [];
  for (const item of results) {
    if (hits.length >= limit) break;
    if (!item || typeof item !== "object") continue;
    const r = item as { title?: unknown; url?: unknown; content?: unknown };
    const url = typeof r.url === "string" ? r.url : "";
    const title = typeof r.title === "string" ? r.title : "";
    if (!/^https?:\/\//i.test(url) || !title) continue;
    hits.push({ title, url, snippet: typeof r.content === "string" ? r.content : "" });
  }
  return hits;
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

/** 进程内搜索缓存：同一 query 秒回，既省钱又能让 TUI 展示"缓存命中" */
const CACHE = new Map<string, { at: number; value: string }>();
const CACHE_TTL_MS = 10 * 60 * 1000;

/** 便于测试隔离缓存 */
export function clearSearchCache(): void {
  CACHE.clear();
}

export function createWebSearchTool(options: WebSearchOptions = {}): ToolDefinition {
  const endpoint = options.endpoint ?? process.env.DSH_SEARCH_ENDPOINT ?? DEFAULT_SEARCH_ENDPOINT;
  const provider = options.provider ?? (process.env.DSH_SEARCH_PROVIDER === "tavily" ? "tavily" : "html");
  const apiKey = options.apiKey ?? process.env.DSH_TAVILY_KEY;
  const fetchImpl = options.fetchImpl ?? fetch;
  const userAgent = options.userAgent ?? BROWSER_UA;
  const parse = options.parse ?? parseSearchHtml;
  const backend = provider === "tavily" ? TAVILY_ENDPOINT : endpoint;
  /** 缓存开关：html 后端默认开；测试注入 fetchImpl 时自动关，避免测试间串味 */
  const useCache = options.fetchImpl === undefined;

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
      ctx.logger("search.start", { query, limit, endpoint: backend, provider });

      const cacheKey = `${provider}|${backend}|${query}|${limit}`;
      if (useCache) {
        const hit = CACHE.get(cacheKey);
        if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
          ctx.logger("search.cache", { query, hit: true });
          return { content: hit.value };
        }
      }

      if (provider === "tavily" && !apiKey) {
        return {
          content: "[search] 已选 tavily 后端但缺少 API key：请设置 DSH_TAVILY_KEY，或改用默认的 html 后端。",
          isError: true,
        };
      }

      const isTavily = provider === "tavily";
      const target = isTavily ? TAVILY_ENDPOINT : `${endpoint}${endpoint.includes("?") ? "&" : "?"}q=${encodeURIComponent(query)}`;
      const resp = await fetchImpl(target, {
        method: isTavily ? "POST" : "GET",
        headers: isTavily
          ? { "content-type": "application/json", "user-agent": userAgent }
          : {
              "user-agent": userAgent,
              accept: "text/html,application/xhtml+xml",
              "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
            },
        body: isTavily
          ? JSON.stringify({ api_key: apiKey, query, max_results: limit, search_depth: "basic" })
          : undefined,
        signal: ctx.signal,
        redirect: "follow",
      });

      if (!resp.ok) {
        ctx.logger("search.done", { query, status: resp.status, provider });
        return { content: `[search] ${backend} 返回 HTTP ${resp.status} ${resp.statusText}`, isError: true };
      }

      let results: SearchHit[];
      if (isTavily) {
        let json: unknown;
        try {
          json = await resp.json();
        } catch {
          return { content: "[search] Tavily 返回的不是合法 JSON", isError: true };
        }
        results = parseTavilyJson(json, limit);
      } else {
        results = parse(await resp.text(), limit);
      }
      ctx.logger("search.done", { query, count: results.length, ms: Date.now() - started, provider });

      if (results.length === 0) {
        return {
          content: JSON.stringify({
            query,
            endpoint: backend,
            provider,
            count: 0,
            results: [],
            note: isTavily
              ? "Tavily 没返回结果：检查 key 是否有效、是否还有额度。"
              : "结果页没解析出条目：可能被反爬拦截，或关键词无结果。可换 DSH_SEARCH_ENDPOINT 再试。",
          }),
          isError: true,
        };
      }
      const value = JSON.stringify({ query, endpoint: backend, provider, count: results.length, results });
      if (useCache) CACHE.set(cacheKey, { at: Date.now(), value });
      return { content: value };
    },
  };
}

/** 默认实例：端点取 DSH_SEARCH_ENDPOINT，未设置则用必应 */
export const webSearchTool: ToolDefinition = createWebSearchTool();
