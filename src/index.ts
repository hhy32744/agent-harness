/**
 * 内核的公共出口。上层（CLI / 爬虫 agent）只从这里 import。
 */
export { runAgent } from "./agent";
export type { AgentOptions, AgentRun } from "./agent";
export { runAgentLoop } from "./agent-loop";
export type { LoopDeps, LoopResult, LoopStatus } from "./agent-loop";

export { OpenAICompatibleClient } from "./llm/openai-client";
export type { OpenAICompatibleOptions } from "./llm/openai-client";
export { ScriptedLLM, say } from "./llm/scripted-client";
export type { ScriptStep } from "./llm/scripted-client";
export type { ChatRequest, LLMClient } from "./llm/types";

export { Scope } from "./scope";
export type { CheckResult, ScopePolicy } from "./scope";

export { Session } from "./session";
export type { SessionEvent, SessionEventType, SessionSnapshot } from "./session";

export { buildSystemPrompt } from "./system-prompt";

// 预设插件管理：人设 + 工具策略 + 边界 + 启停/导入导出的配置包
export { PresetManager, defaultPresetFile, BUILTIN_PRESETS, cloneBuiltins, applyToolPolicy, normalizePolicy, makeId } from "./preset";
export type {
  Preset,
  PresetFile,
  PresetManifestItem,
  ResolvedPreset,
  ToolPolicy,
  ToolPolicyMode,
} from "./preset";

// 终端 TUI：课程示例风格的交互式会话界面
export { runTui, createTuiIO } from "./tui";
export type { TuiIO, TuiOptions, TuiOutcome } from "./tui";
export {
  renderBanner,
  renderUser,
  renderEvent,
  renderAnswer,
  renderDone,
  renderHelp,
  newRenderState,
  palette,
  DSH_BANNER,
} from "./tui/render";
export type { Palette, RenderState } from "./tui/render";

export {
  ToolRegistry,
  webTools,
  fetchUrlTool,
  extractLinksTool,
  saveMarkdownTool,
  webSearchTool,
  createWebSearchTool,
  parseDuckDuckGoHtml,
  parseTavilyJson,
  clearSearchCache,
  createToolset,
  DEFAULT_TOOL_NAMES,
} from "./tools";
export type { JsonSchema, SearchHit, ToolContext, ToolDefinition, ToolResult, ToolSpec } from "./tools";

export type {
  AssistantMessage,
  Message,
  Role,
  SystemMessage,
  TokenUsage,
  ToolCall,
  ToolMessage,
  UserMessage,
} from "./types";
export { describeError, newToolCallId } from "./types";
