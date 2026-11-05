/**
 * Agent Loop：整个 harness 的心脏，也是最"简单"的部分。
 *
 * 用伪代码说清楚它就这六行：
 *   while (轮次没超):
 *     assistant = llm(messages, tools)
 *     messages += assistant
 *     if (assistant.tool_calls 为空) return 最终答案
 *     for call of tool_calls:
 *       messages += 执行(call) 的结果
 *
 * 真正的工作量在"如果"后面的失败路径上：超时、非法参数、被 scope 拒绝、
 * 轮次/次数预算用尽、外部取消。这些路径都必须有确定的行为和可读的记录，
 * 否则 agent 在生产里只会表现成"偶发卡死"或"莫名空转"。
 */
import type { LLMClient } from "../llm/types";
import type { Scope } from "../scope";
import type { Session, SessionEvent } from "../session";
import type { ToolRegistry } from "../tools/registry";
import type { TokenUsage } from "../types";
import { describeError } from "../types";

export type LoopStatus = "completed" | "max_turns" | "tool_budget" | "aborted" | "error";

export interface LoopResult {
  status: LoopStatus;
  /** 最终答复文本；非 completed 时可能是最后一次模型的中间说明 */
  text: string;
  turns: number;
  toolCalls: number;
  usage: TokenUsage;
  error?: string;
}

export interface LoopDeps {
  llm: LLMClient;
  registry: ToolRegistry;
  session: Session;
  scope: Scope;
  signal?: AbortSignal;
  /** 事件外抛，CLI 用来实时打印，测试用来断言 */
  onEvent?: (event: SessionEvent) => void;
}

const ZERO_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

export async function runAgentLoop(deps: LoopDeps): Promise<LoopResult> {
  const { llm, registry, session, scope, signal, onEvent } = deps;
  const maxTurns = scope.policy.maxTurns;
  const maxToolCalls = scope.policy.maxToolCalls;

  let usage: TokenUsage = { ...ZERO_USAGE };
  let turns = 0;
  let toolCallsUsed = 0;
  let lastText = "";

  const emit = (type: Parameters<Session["record"]>[0], data: Record<string, unknown>, turn: number) => {
    const event = session.record(type, data, turn);
    onEvent?.(event);
    return event;
  };

  try {
    while (turns < maxTurns) {
      if (signal?.aborted) {
        emit("session.end", { status: "aborted", reason: "调用方取消" }, turns);
        return { status: "aborted", text: lastText, turns, toolCalls: toolCallsUsed, usage };
      }

      turns += 1;

      // 每轮都重新取 specs：工具集可以在运行中被上层调整
      const assistant = await llm.chat({
        messages: [...session.messages],
        tools: registry.specs(),
        signal,
      });
      session.append(assistant);
      usage = addUsage(usage, assistant.usage);
      lastText = assistant.content;
      emit(
        "assistant.message",
        {
          turn: turns,
          chars: assistant.content.length,
          toolCalls: assistant.toolCalls.length,
          preview: assistant.content.slice(0, 120),
        },
        turns,
      );

      if (assistant.toolCalls.length === 0) {
        emit("session.end", { status: "completed", turns, toolCalls: toolCallsUsed }, turns);
        return { status: "completed", text: assistant.content, turns, toolCalls: toolCallsUsed, usage };
      }

      for (const call of assistant.toolCalls) {
        if (toolCallsUsed >= maxToolCalls) {
          // 预算用尽：明确告诉模型"别调了"，并把它当成一次拒绝记录下来
          session.append({
            role: "tool",
            toolCallId: call.id,
            name: call.name,
            content: `[budget] 工具调用次数已达上限 ${maxToolCalls}，请直接用已有信息作答。`,
            isError: true,
          });
          emit("turn.limit", { reason: "tool_budget", maxToolCalls }, turns);
          emit("session.end", { status: "tool_budget", turns, toolCalls: toolCallsUsed }, turns);
          return {
            status: "tool_budget",
            text: lastText,
            turns,
            toolCalls: toolCallsUsed,
            usage,
          };
        }

        toolCallsUsed += 1;
        emit("tool.call", { name: call.name, args: call.args, callId: call.id }, turns);

        const toolMessage = await registry.invoke(call, {
          scope,
          sessionId: session.id,
          signal,
          logger: (event, detail) => {
            // 工具内部上报细粒度事件（抓取耗时、字节数等）
            emit("tool.note", { event, detail: detail as Record<string, unknown> }, turns);
          },
        });
        session.append(toolMessage);
        emit(
          "tool.result",
          {
            name: call.name,
            callId: call.id,
            isError: toolMessage.isError,
            chars: toolMessage.content.length,
            preview: toolMessage.content.slice(0, 160),
          },
          turns,
        );
      }
    }

    emit("turn.limit", { reason: "max_turns", maxTurns }, turns);
    emit("session.end", { status: "max_turns", turns, toolCalls: toolCallsUsed }, turns);
    return { status: "max_turns", text: lastText, turns, toolCalls: toolCallsUsed, usage };
  } catch (err) {
    const message = describeError(err);
    emit("error", { message }, turns);
    emit("session.end", { status: "error", turns }, turns);
    return { status: "error", text: lastText, turns, toolCalls: toolCallsUsed, usage, error: message };
  }
}

function addUsage(a: TokenUsage, b?: TokenUsage): TokenUsage {
  if (!b) return a;
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}
