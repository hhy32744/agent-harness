/**
 * Agent：core 的装配层，只干四件事——建工具表、建会话、塞系统提示词、调 loop。
 *
 * 判断逻辑一律留在 agent-loop 里，这里不做任何分支。
 * 想换模型就换 llm，想收边界就换 scope，都不需要动这个文件。
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

export class Agent {
  readonly session = new Session();
  readonly registry: ToolRegistry;
  readonly scope: Scope;
  private readonly llm: LLMClient;
  private readonly onEvent?: (event: SessionEvent) => void;

  constructor(opts: AgentOptions) {
    this.llm = opts.llm;
    this.onEvent = opts.onEvent;
    this.scope = opts.scope ?? new Scope();
    this.registry = new ToolRegistry().register(...opts.tools);

    this.session.append({
      role: "system",
      content:
        opts.systemPrompt ??
        buildSystemPrompt({
          role: opts.role ?? "通用助手",
          tools: this.registry.specs(),
          scope: this.scope,
        }),
    });
    this.session.record("session.start", {
      agent: opts.name ?? "agent",
      llm: this.llm.name,
      tools: this.registry.specs().map((t) => t.name),
    });
  }

  /** 追加一条 user 消息，然后跑到底；结果与会话都在对象上 */
  run(input: string, signal?: AbortSignal): Promise<LoopResult> {
    this.session.append({ role: "user", content: input });
    this.session.record("user.message", { chars: input.length, preview: input.slice(0, 120) });
    return runAgentLoop({
      llm: this.llm,
      registry: this.registry,
      session: this.session,
      scope: this.scope,
      signal,
      onEvent: this.onEvent,
    });
  }
}
