import type { Scope } from "../scope";
import type { ToolSpec } from "../tools/types";

export interface SystemPromptOptions {
  /** agent 的角色定位，例如"网页信息抽取助手" */
  role: string;
  /** 本次会话暴露给模型的工具 */
  tools: ToolSpec[];
  scope: Scope;
  /** 额外的业务约束（比如输出格式） */
  extraRules?: string[];
}

/**
 * 系统提示词由代码拼装而不是写死一份长文本。
 * 原因：工具列表和作用域是运行时决定的，提示词必须跟着变，
 * 否则模型会去调用一个根本不存在 / 被禁用的工具。
 */
export function buildSystemPrompt(opts: SystemPromptOptions): string {
  const { role, tools, scope, extraRules = [] } = opts;
  const allowHosts = scope.policy.allowedHosts;

  const toolLines = tools.length
    ? tools.map((t) => `- ${t.name}：${t.description}`).join("\n")
    : "- （当前没有可用工具，只能直接作答）";

  const lines = [
    `你是 ${role}。你运行在一个受限的 agent 循环里：每轮只能做一件事——要么调用工具，要么给出最终答复。`,
    "",
    "## 可用工具",
    toolLines,
    "",
    "## 工作准则",
    "1. 需要外部信息时先调用工具，不要凭猜测编造页面内容。",
    "2. 一次只调用必要的工具；拿到结果后先判断是否已满足目标，再决定下一步。",
    "3. 工具返回 isError 时读错误信息，修正参数后最多重试一次；仍失败就如实说明。",
    "4. 不要在答复里伪造你没有真正抓取到的数据。",
    "",
    "## 边界",
    allowHosts
      ? `- 只能访问这些主机：${allowHosts.join("、")}。白名单外的主机一律拒绝。`
      : "- 未限制抓取主机，但仍不得访问内网地址。",
    `- 最多 ${scope.policy.maxTurns} 轮、${scope.policy.maxToolCalls} 次工具调用；预算用尽会被强制停止。`,
    ...(extraRules.length ? ["", "## 输出要求", ...extraRules.map((r) => `- ${r}`)] : []),
  ];

  return lines.join("\n");
}
