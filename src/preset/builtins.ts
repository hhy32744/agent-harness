/**
 * 内置预设：开箱即用的三种角色。
 * 用户可启停 / 复制 / 编辑它们，但不可删除（builtin: true）。
 */
import type { Preset } from "./types";

export const BUILTIN_PRESETS: readonly Preset[] = [
  {
    id: "builtin:web",
    name: "网页检索",
    description: "默认预设：先搜再抓，完整四件套（web_search / fetch_url / extract_links / save_markdown）",
    enabled: true,
    order: 10,
    role: "网页检索与信息抽取助手",
    tools: { mode: "all", names: [] },
    scope: {},
    extraRules: [],
    builtin: true,
  },
  {
    id: "builtin:search-only",
    name: "只搜索",
    description: "只允许 web_search：只要候选链接与摘要，不抓正文，最省额度",
    enabled: true,
    order: 20,
    role: "网页搜索助手，只返回候选链接与摘要，不抓取正文",
    tools: { mode: "whitelist", names: ["web_search"] },
    scope: { maxTurns: 4, maxToolCalls: 4 },
    extraRules: ["回答时标明每条结论来自哪条搜索结果的标题与链接。"],
    builtin: true,
  },
  {
    id: "builtin:readonly-crawl",
    name: "只读抓取",
    description: "只允许抓取类工具，禁用 web_search 与落盘，适合已知 URL 的精读",
    enabled: true,
    order: 30,
    role: "网页精读助手，按给定 URL 抓取并抽取正文",
    tools: { mode: "whitelist", names: ["fetch_url", "extract_links"] },
    scope: { maxTurns: 6, maxToolCalls: 8 },
    extraRules: [],
    builtin: true,
  },
];

export function cloneBuiltins(): Preset[] {
  return BUILTIN_PRESETS.map((p) => ({
    ...p,
    tools: { ...p.tools, names: [...p.tools.names] },
    scope: { ...p.scope },
    extraRules: [...p.extraRules],
  }));
}
