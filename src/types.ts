/**
 * core 公共类型。
 *
 * 整个 harness 只围绕一种数据结构运转：Message[]。
 * LLM 读它、工具结果写它、会话存档的就是它。其余模块都是围绕这条消息流的"外设"。
 */

/** 会话中出现的四种角色，与 OpenAI / DeepSeek Chat Completions 协议一一对应 */
export type Role = "system" | "user" | "assistant" | "tool";

/** 模型发起的一次工具调用请求 */
export interface ToolCall {
  /** 协议侧 id，工具结果必须按这个 id 回填，否则模型对不上号 */
  id: string;
  /** 工具名，必须在 ToolRegistry 中注册过 */
  name: string;
  /** 解析后的参数对象 */
  args: Record<string, unknown>;
  /** 原始参数文本；模型偶尔会吐出非法 JSON，保留原文便于回报错误 */
  rawArgs?: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface SystemMessage {
  role: "system";
  content: string;
}

export interface UserMessage {
  role: "user";
  content: string;
}

export interface AssistantMessage {
  role: "assistant";
  /** 纯文本回复；发起工具调用时通常为空串 */
  content: string;
  /** 空数组表示模型认为任务已结束 —— 这是 loop 的退出条件 */
  toolCalls: ToolCall[];
  usage?: TokenUsage;
}

export interface ToolMessage {
  role: "tool";
  /** 对应 ToolCall.id */
  toolCallId: string;
  name: string;
  content: string;
  /** true 时模型会看到错误信息并自行决定重试或换路 */
  isError: boolean;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

/** 新建一个未命名的工具调用 id（mock / 离线场景用） */
export function newToolCallId(prefix = "call"): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 把任意错误对象压成一行可读文本，喂回模型或写日志 */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    return cause ? `${err.name}: ${err.message} (cause: ${String(cause)})` : `${err.name}: ${err.message}`;
  }
  return String(err);
}
