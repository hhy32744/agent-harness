/**
 * 脚本化 LLM：离线把 agent loop 的每条分支都跑到。
 *
 * 存在的意义有两个：
 *   1) 没有 API key / 没有网络时，也能演示"模型 → 工具 → 模型"的完整闭环；
 *   2) 单元测试可以在毫秒级、零费用下覆盖 loop 的行为。
 * 它只实现 LLMClient 接口，因此对 core 而言与真实模型没有任何区别。
 */
import type { AssistantMessage } from "../types";
import { describeError } from "../types";
import type { ChatRequest, LLMClient } from "./types";

/** 一步脚本：拿到当前请求，返回一条 assistant 消息；也可以直接给一条固定消息 */
export type ScriptStep = (req: ChatRequest, index: number) => AssistantMessage | Promise<AssistantMessage>;

export class ScriptedLLM implements LLMClient {
  readonly name = "scripted-llm";
  calls = 0;
  private readonly steps: Array<ScriptStep | AssistantMessage>;

  constructor(steps: Array<ScriptStep | AssistantMessage>) {
    if (steps.length === 0) throw new Error("ScriptedLLM 至少需要一步脚本");
    this.steps = steps;
  }

  async chat(req: ChatRequest): Promise<AssistantMessage> {
    const index = Math.min(this.calls, this.steps.length - 1);
    this.calls += 1;
    const step = this.steps[index]!;
    try {
      return typeof step === "function" ? await step(req, index) : step;
    } catch (err) {
      // 脚本写错不应该让整个 loop 崩掉，等价于模型返回了一句"我失败了"
      return { role: "assistant", content: `脚本执行异常：${describeError(err)}`, toolCalls: [] };
    }
  }
}

/** 便捷构造：一次纯文本回复 */
export function say(content: string): AssistantMessage {
  return { role: "assistant", content, toolCalls: [] };
}
