import type { AssistantMessage, Message } from "../types";
import type { ToolSpec } from "../tools/types";

/** 一次对话请求：消息流 + 当前可用工具 + 取消信号 */
export interface ChatRequest {
  messages: Message[];
  tools: ToolSpec[];
  signal?: AbortSignal;
}

/**
 * 模型侧唯一抽象。
 * core 不关心背后是 DeepSeek、OpenAI 还是脚本 mock，只要能吐 AssistantMessage。
 * 这样测试可以在零网络、零费用的条件下把 loop 全部路径跑一遍。
 */
export interface LLMClient {
  readonly name: string;
  chat(req: ChatRequest): Promise<AssistantMessage>;
}
