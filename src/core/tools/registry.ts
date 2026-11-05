/**
 * ToolRegistry：core 里唯一执行"外部动作"的地方。
 *
 * 它负责四件事，缺一不可：
 *   1) 把工具声明转成模型能读的 spec 列表；
 *   2) 按 Scope 做准入（白名单 / 禁用）；
 *   3) 给每次执行套超时，避免一个卡死的工具拖住整条会话；
 *   4) 把任何异常收敛成 isError 的 tool 消息，而不是让进程崩掉 ——
 *      agent 的健壮性来自"错误也是模型可读的输入"。
 */
import type { ToolCall, ToolMessage } from "../types";
import { describeError } from "../types";
import type { ToolContext, ToolDefinition, ToolSpec } from "./types";

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(...tools: ToolDefinition[]): this {
    for (const tool of tools) {
      if (this.tools.has(tool.name)) throw new Error(`工具重复注册：${tool.name}`);
      this.tools.set(tool.name, tool);
    }
    return this;
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get size(): number {
    return this.tools.size;
  }

  specs(): ToolSpec[] {
    return [...this.tools.values()].map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }));
  }

  /**
   * 执行一次工具调用，永远返回一条 tool 消息（不抛异常）。
   * 成功 / 未知工具 / 被作用域拒绝 / 超时 / 业务异常，全部走同一个出口。
   */
  async invoke(call: ToolCall, ctx: ToolContext): Promise<ToolMessage> {
    const started = Date.now();
    const deny = (reason: string): ToolMessage => {
      ctx.logger("rejected", { name: call.name, reason, ms: Date.now() - started });
      return { role: "tool", toolCallId: call.id, name: call.name, content: `[scope] ${reason}`, isError: true };
    };

    const verdict = ctx.scope.canUseTool(call.name);
    if (!verdict.allowed) return deny(verdict.reason ?? `工具 ${call.name} 不可用`);

    const tool = this.tools.get(call.name);
    if (!tool) {
      const available = [...this.tools.keys()].join(", ") || "（无）";
      return deny(`未知工具 ${call.name}；当前可用工具：${available}`);
    }

    if (call.rawArgs !== undefined) {
      ctx.logger("bad-args", { name: call.name, raw: call.rawArgs.slice(0, 200) });
      return {
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: `[invalid-json] 参数不是合法 JSON，请重新给出 ${call.name} 的参数。原文：${call.rawArgs.slice(0, 300)}`,
        isError: true,
      };
    }

    try {
      const result = await withTimeout(
        // run 允许同步返回，这里统一收成 Promise
        async (signal) => tool.run(call.args, { ...ctx, signal }),
        ctx.scope.policy.toolTimeoutMs,
        ctx.signal,
      );
      const content = clamp(result.content ?? "", ctx.scope.policy.maxOutputChars);
      // 成功路径的统计由 agent-loop 统一记 tool.result，这里不再重复上报
      return {
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content,
        isError: Boolean(result.isError),
      };
    } catch (err) {
      const message = describeError(err);
      ctx.logger("error", { name: call.name, message, ms: Date.now() - started });
      return {
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: `[error] ${call.name} 执行失败：${message}`,
        isError: true,
      };
    }
  }
}

/** 超时 + 外部取消，两者都收敛成可读错误 */
async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number,
  outer?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`工具执行超过 ${ms}ms`)), ms);
  const onAbort = () => controller.abort(outer?.reason ?? new Error("已取消"));
  if (outer) {
    if (outer.aborted) onAbort();
    else outer.addEventListener("abort", onAbort, { once: true });
  }

  // 关键：不能只依赖工具自己监听 signal —— 一个卡死的工具根本不会理会 abort。
  // 所以这里必须用 race 把 abort 变成一次真正的拒绝。
  const aborted = new Promise<never>((_, reject) => {
    if (controller.signal.aborted) {
      reject(controller.signal.reason ?? new Error("已取消"));
      return;
    }
    controller.signal.addEventListener(
      "abort",
      () => reject(controller.signal.reason ?? new Error("已取消")),
      { once: true },
    );
  });

  try {
    return await Promise.race([run(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onAbort);
  }
}

function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...[已截断 ${text.length - max} 字符，超出 maxOutputChars=${max}]`;
}
