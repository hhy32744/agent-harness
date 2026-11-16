/**
 * 工具集装配：把"用哪些工具"从命令行参数 / 配置文件翻译成 ToolDefinition[]。
 *
 * 内核只认 ToolDefinition[]，不认识工具名。名字到实现的映射集中在这里，
 * CLI、示例、测试都从这里取，避免三处各写一份白名单。
 */
import type { ToolDefinition } from "./types";
import { extractLinksTool, fetchUrlTool, saveMarkdownTool } from "./builtin/web";
import { createWebSearchTool } from "./builtin/websearch";

/** 爬虫默认工具集：先搜、再抓、抽链接、落盘 */
export const DEFAULT_TOOL_NAMES = ["web_search", "fetch_url", "extract_links", "save_markdown"] as const;

export interface ToolsetOptions {
  /** 覆盖搜索端点（默认取 DSH_SEARCH_ENDPOINT） */
  searchEndpoint?: string;
  /** 便于测试注入 fetch */
  fetchImpl?: typeof fetch;
}

export function createToolset(names: readonly string[] = DEFAULT_TOOL_NAMES, options: ToolsetOptions = {}): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  for (const name of names) {
    switch (name) {
      case "web_search":
        tools.push(createWebSearchTool({ endpoint: options.searchEndpoint, fetchImpl: options.fetchImpl }));
        break;
      case "fetch_url":
        tools.push(fetchUrlTool);
        break;
      case "extract_links":
        tools.push(extractLinksTool);
        break;
      case "save_markdown":
        tools.push(saveMarkdownTool);
        break;
      default:
        throw new Error(`未知工具 ${name}；可选：${DEFAULT_TOOL_NAMES.join(", ")}`);
    }
  }
  return tools;
}
