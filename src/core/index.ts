/**
 * core 的公共出口。上层（CLI / 未来的爬虫 agent）只从 here import。
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

export { ToolRegistry, webTools, fetchUrlTool, extractLinksTool, saveMarkdownTool } from "./tools";
export type { JsonSchema, ToolContext, ToolDefinition, ToolResult, ToolSpec } from "./tools/types";

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
