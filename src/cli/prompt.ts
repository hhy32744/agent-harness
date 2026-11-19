/**
 * 非交互任务：dsh prompt "<文本>" 就是它。
 *
 * 与交互模式的唯一区别是会话生命周期：这里一次任务一个 Session，
 * 跑完打印结果就退出 —— 适合放进脚本、CI、定时任务里。
 */
import { runAgent } from "../agent";
import type { LoopResult } from "../agent-loop";
import type { LLMClient } from "../llm/types";
import type { Scope } from "../scope";
import type { Session, SessionEvent } from "../session";
import type { ToolDefinition } from "../tools/types";
import { formatEvent, formatSummary } from "./render";

export interface PromptOptions {
  llm: LLMClient;
  tools: ToolDefinition[];
  scope: Scope;
  role: string;
  /** 预设注入的额外规则 */
  extraRules?: string[];
  name?: string;
  io: { print(line?: string): void };
  /** 打印过程事件，默认 true；--quiet 时关掉 */
  verbose?: boolean;
  onEvent?: (event: SessionEvent) => void;
}

export interface PromptOutcome {
  task: string;
  result: LoopResult;
  session: Session;
  elapsedMs: number;
}

export async function runPromptTask(task: string, opts: PromptOptions): Promise<PromptOutcome> {
  const verbose = opts.verbose !== false;
  const started = Date.now();

  const { result, session } = await runAgent(
    task,
    {
      llm: opts.llm,
      tools: opts.tools,
      scope: opts.scope,
      role: opts.role,
      extraRules: opts.extraRules,
      name: opts.name ?? "dsh-prompt",
      onEvent: (event) => {
        opts.onEvent?.(event);
        if (!verbose) return;
        const line = formatEvent(event);
        if (line) opts.io.print(line);
      },
    },
  );

  return { task, result, session, elapsedMs: Date.now() - started };
}

/** --json 输出：给脚本和远端调用方解析的稳定结构 */
export function toJson(outcome: PromptOutcome): string {
  const { result, session, elapsedMs } = outcome;
  return JSON.stringify(
    {
      task: outcome.task,
      status: result.status,
      text: result.text,
      turns: result.turns,
      toolCalls: result.toolCalls,
      usage: result.usage,
      elapsedMs,
      sessionId: session.id,
      error: result.error,
    },
    null,
    2,
  );
}

export function formatOutcome(outcome: PromptOutcome): string[] {
  const lines = [outcome.result.text || "（模型没有给出文本答复）", ""];
  if (outcome.result.error) lines.unshift(`错误：${outcome.result.error}`, "");
  lines.push(formatSummary(outcome.result, outcome.elapsedMs));
  lines.push(`会话 ${outcome.session.id}（${outcome.session.messages.length} 条消息）`);
  return lines;
}
