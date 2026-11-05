/**
 * OpenAI 协议兼容的 LLM 客户端。
 * DeepSeek 官方 API（https://api.deepseek.com）与 OpenAI / vLLM / Ollama 的
 * /v1/chat/completions 是同构的，所以一个实现可以全部覆盖。
 */
import type { AssistantMessage, Message, ToolCall } from "../types";
import { newToolCallId } from "../types";
import type { ChatRequest, LLMClient } from "./types";

export interface OpenAICompatibleOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** 便于注入测试用的 fetch，生产走全局 fetch */
  fetchImpl?: typeof fetch;
  extraHeaders?: Record<string, string>;
}

interface WireToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface WireChoice {
  message?: { content?: string | null; tool_calls?: WireToolCall[] };
  finish_reason?: string;
}

interface WireResponse {
  choices?: WireChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export class OpenAICompatibleClient implements LLMClient {
  readonly name: string;
  private readonly opts: Required<Omit<OpenAICompatibleOptions, "fetchImpl" | "extraHeaders">> & {
    fetchImpl: typeof fetch;
    extraHeaders: Record<string, string>;
  };

  constructor(options: OpenAICompatibleOptions) {
    this.opts = {
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
      temperature: 0.2,
      maxTokens: 1024,
      timeoutMs: 60000,
      ...options,
      fetchImpl: options.fetchImpl ?? fetch,
      extraHeaders: options.extraHeaders ?? {},
    };
    this.name = `openai-compatible:${this.opts.model}`;
  }

  async chat(req: ChatRequest): Promise<AssistantMessage> {
    const body = {
      model: this.opts.model,
      messages: req.messages.map(toWireMessage),
      ...(req.tools.length > 0
        ? {
            tools: req.tools.map((t) => ({
              type: "function" as const,
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
            tool_choice: "auto" as const,
          }
        : {}),
      temperature: this.opts.temperature,
      max_tokens: this.opts.maxTokens,
      stream: false,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("LLM 请求超时")), this.opts.timeoutMs);
    const onOuterAbort = () => controller.abort(req.signal?.reason);
    req.signal?.addEventListener("abort", onOuterAbort, { once: true });

    try {
      const resp = await this.opts.fetchImpl(`${trimSlash(this.opts.baseUrl)}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.opts.apiKey}`,
          ...this.opts.extraHeaders,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const text = await safeText(resp);
        throw new Error(`LLM HTTP ${resp.status} ${resp.statusText}: ${text.slice(0, 500)}`);
      }

      const data = (await resp.json()) as WireResponse;
      const choice = data.choices?.[0];
      if (!choice?.message) throw new Error(`LLM 返回体缺少 choices[0].message: ${JSON.stringify(data).slice(0, 300)}`);

      const toolCalls = (choice.message.tool_calls ?? []).map(parseToolCall);
      return {
        role: "assistant",
        content: choice.message.content ?? "",
        toolCalls,
        usage: data.usage
          ? {
              promptTokens: data.usage.prompt_tokens ?? 0,
              completionTokens: data.usage.completion_tokens ?? 0,
              totalTokens: data.usage.total_tokens ?? 0,
            }
          : undefined,
      };
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onOuterAbort);
    }
  }
}

/** 把内部 Message 映射成协议要求的线格式 */
export function toWireMessage(msg: Message): Record<string, unknown> {
  switch (msg.role) {
    case "assistant": {
      const base: Record<string, unknown> = { role: "assistant", content: msg.content || null };
      if (msg.toolCalls.length > 0) {
        base.tool_calls = msg.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.rawArgs ?? JSON.stringify(c.args) },
        }));
      }
      return base;
    }
    case "tool":
      return { role: "tool", tool_call_id: msg.toolCallId, content: msg.content };
    default:
      return { role: msg.role, content: msg.content };
  }
}

function parseToolCall(raw: WireToolCall): ToolCall {
  const name = raw.function?.name ?? "unknown_tool";
  const argText = raw.function?.arguments ?? "{}";
  let args: Record<string, unknown> = {};
  let rawArgs: string | undefined;
  try {
    const parsed = JSON.parse(argText);
    args = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    // 非法 JSON 不在这里抛错：交给 loop 把错误回填给模型，让它自己修参数
    rawArgs = argText;
  }
  return { id: raw.id ?? newToolCallId(), name, args, rawArgs };
}

async function safeText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return "<无法读取响应体>";
  }
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}
