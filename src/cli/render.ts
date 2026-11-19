/**
 * 事件渲染：把 SessionEvent 变成人看的一行字。
 *
 * 单独一层的原因：同一个 session 既要给人看（CLI），也要给机器看（--json），
 * 还要给测试断言。渲染逻辑抽出来后，三处共用同一份事实，不各写一套。
 */
import type { SessionEvent } from "../session";
import type { LoopResult } from "../agent-loop";

const PREVIEW_MAX = 110;

export function formatEvent(event: SessionEvent): string | null {
  const turn = event.turn > 0 ? `第${event.turn}轮` : "";
  switch (event.type) {
    case "session.start":
      return `= 会话启动 agent=${String(event.data.agent)} llm=${String(event.data.llm)} tools=${(event.data.tools as string[]).length}`;
    case "user.message":
      return null; // 交互模式里用户自己知道刚输的什么
    case "assistant.message": {
      const calls = Number(event.data.toolCalls ?? 0);
      // 最终答复由调用方整段打印，这里只报"这一轮要调工具"的中间态，避免同一段话出现两次
      if (calls === 0) return null;
      const preview = String(event.data.preview ?? "").replace(/\s+/g, " ").slice(0, PREVIEW_MAX);
      return `· ${turn}助手：${preview || "（无文本）"}（发起 ${calls} 个工具调用）`;
    }
    case "tool.call": {
      const args = JSON.stringify(event.data.args ?? {});
      return `  -> ${String(event.data.name)} ${args.slice(0, 160)}`;
    }
    case "tool.result": {
      const bad = event.data.isError ? "失败" : "ok";
      return `  <- ${String(event.data.name)} ${bad}（${String(event.data.chars)} 字）`;
    }
    case "tool.note": {
      const detail = event.data.detail === undefined ? "" : ` ${JSON.stringify(event.data.detail).slice(0, 160)}`;
      return `    · ${String(event.data.event)}${detail}`;
    }
    case "turn.limit":
      return `  ! 预算用尽 ${JSON.stringify(event.data)}`;
    case "session.end":
      return `= 会话结束 status=${String(event.data.status)} 轮次=${String(event.data.turns ?? 0)} 工具=${String(event.data.toolCalls ?? 0)}`;
    case "error":
      return `x 错误：${String(event.data.message)}`;
    case "session.fork":
      return `= 分支会话 ${JSON.stringify(event.data)}`;
    case "tool.denied":
      return `  ! 工具被拒 ${String(event.data.reason ?? "")}`;
    default:
      return null;
  }
}

/** 一次任务的一行摘要，交互模式和 prompt 模式都用它收尾 */
export function formatSummary(result: LoopResult, elapsedMs: number): string {
  const { promptTokens, completionTokens, totalTokens } = result.usage;
  // 输入/输出单价不同，分开打印方便对照账单；未知时退回总数
  const usage =
    totalTokens > 0
      ? ` token=${totalTokens}（输入 ${promptTokens} / 输出 ${completionTokens}）`
      : "";
  return `-- ${result.status} | ${result.turns} 轮 | ${result.toolCalls} 次工具 | ${elapsedMs}ms${usage}`;
}
