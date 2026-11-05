/**
 * Agent：把 core 的五个零件装成一台能跑的东西。
 *
 *   llm      决定下一步做什么
 *   registry 真的去做
 *   session  记住做过什么
 *   scope    限制能做什么
 *   loop     把上面四者按轮次串起来
 *
 * Agent 自己不加任何业务逻辑 —— 换模型、换工具、换策略，都只是换零件。
 */
import { runAgentLoop, type LoopResult } from "../agent-loop";
import type { LLMClient } from "../llm/types";
import { Scope } from "../scope";
import { Session, type SessionEvent } from "../session";
import { buildSystemPrompt } from "../system-prompt";
import { ToolRegistry } from "../tools/registry";
import type { ToolDefinition } from "../tools/types";
import type { Message } from "../types";

export interface AgentOptions {
  name: string;
  role: string;
  llm: LLMClient;
  tools: ToolDefinition[];
  scope?: Scope;
  /** 覆盖自动生成的系统提示词 */
  systemPrompt?: string;
  extraRules?: string[];
  /** 已有会话，用于续跑 / 分支 */
  session?: Session;
  onEvent?: (event: SessionEvent) => void;
}

export interface RunResult {
  session: Session;
  result: LoopResult;
}

export class Agent {
  readonly name: string;
  readonly role: string;
  readonly scope: Scope;
  readonly registry: ToolRegistry;
  readonly session: Session;
  readonly systemPrompt: string;
  private readonly llm: LLMClient;
  private readonly onEvent?: (event: SessionEvent) => void;

  constructor(opts: AgentOptions) {
    this.name = opts.name;
    this.role = opts.role;
    this.llm = opts.llm;
    this.scope = opts.scope ?? new Scope();
    this.registry = new ToolRegistry().register(...opts.tools);
    this.session = opts.session ?? new Session();
    this.onEvent = opts.onEvent;
    this.systemPrompt =
      opts.systemPrompt ??
      buildSystemPrompt({
        role: opts.role,
        tools: this.registry.specs(),
        scope: this.scope,
        extraRules: opts.extraRules,
      });

    if (!this.session.messages.some((m: Message) => m.role === "system")) {
      this.session.append({ role: "system", content: this.systemPrompt });
    }
    this.session.record("session.start", {
      agent: this.name,
      llm: this.llm.name,
      tools: this.registry.specs().map((t) => t.name),
      maxTurns: this.scope.policy.maxTurns,
      maxToolCalls: this.scope.policy.maxToolCalls,
    });
  }

  /** 一次 run = 追加一条 user 消息 + 跑到底 */
  async run(input: string, opts: { signal?: AbortSignal } = {}): Promise<RunResult> {
    this.session.append({ role: "user", content: input });
    this.session.record("user.message", { chars: input.length, preview: input.slice(0, 120) });

    const result = await runAgentLoop({
      llm: this.llm,
      registry: this.registry,
      session: this.session,
      scope: this.scope,
      signal: opts.signal,
      onEvent: this.onEvent,
    });

    return { session: this.session, result };
  }
}
