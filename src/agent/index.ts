/**
 * agent：core 的一行入口。
 *
 * 只做四件事——建工具表、建会话、塞系统提示词、调 loop，然后返回结果。
 * 没有类、没有状态、没有分支；要控制会话生命周期（续跑/分支）就直接用 runAgentLoop。
 */
import { runAgentLoop, type LoopResult } from "../agent-loop";
import type { LLMClient } from "../llm/types";
import { Scope } from "../scope";
import { Session, type SessionEvent } from "../session";
import { buildSystemPrompt } from "../system-prompt";
import { ToolRegistry } from "../tools/registry";
import type { ToolDefinition } from "../tools/types";

export interface AgentOptions {
  llm: LLMClient;
  tools: ToolDefinition[];
  /** 不传则用默认策略（8 轮 / 16 次工具调用） */
  scope?: Scope;
  /** 角色描述，用于自动生成系统提示词 */
  role?: string;
  /** 直接给一整份系统提示词；给了就不再自动拼 */
  systemPrompt?: string;
  /** 事件回调，CLI 用来实时打印，测试用来断言 */
  onEvent?: (event: SessionEvent) => void;
  /** 仅用于事件记录里标识是哪个 agent */
  name?: string;
}

export interface AgentRun {
  result: LoopResult;
  /** 完整消息流与事件都在这里 */
  session: Session;
}

/** 跑一次完整任务：追加一条 user 消息，循环到模型不再调工具 */
export async function runAgent(
  input: string,
  opts: AgentOptions,
  signal?: AbortSignal,
): Promise<AgentRun> {
  const scope = opts.scope ?? new Scope();
  const registry = new ToolRegistry().register(...opts.tools);
  const session = new Session();
  const tools = registry.specs();

  session.append({
    role: "system",
    content: opts.systemPrompt ?? buildSystemPrompt({ role: opts.role ?? "通用助手", tools, scope }),
  });
  session.record("session.start", {
    agent: opts.name ?? "agent",
    llm: opts.llm.name,
    tools: tools.map((t) => t.name),
  });

  session.append({ role: "user", content: input });
  session.record("user.message", { chars: input.length, preview: input.slice(0, 120) });

  const result = await runAgentLoop({ llm: opts.llm, registry, session, scope, signal, onEvent: opts.onEvent });
  return { result, session };
}
