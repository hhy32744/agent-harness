/**
 * 交互式聊天：dsh 不带参数就是它。
 *
 * 关键设计：整个对话**复用同一个 Session**。
 * 每次输入只是往消息流里追加一条 user 消息再跑一次 loop，所以
 * "接着上一轮追问"是天然成立的 —— 不需要任何额外的记忆模块，
 * messages 本身就是记忆。这也解释了 /reset 为什么只是换一个 Session。
 */
import { createInterface } from "node:readline/promises";
import { runAgentLoop } from "../agent-loop";
import type { LLMClient } from "../llm/types";
import type { Scope } from "../scope";
import { Session, type SessionEvent } from "../session";
import { buildSystemPrompt } from "../system-prompt";
import { ToolRegistry } from "../tools/registry";
import type { ToolDefinition, ToolSpec } from "../tools/types";
import { describeError } from "../types";
import { formatEvent, formatSummary } from "./render";

export interface ChatIO {
  /** 返回 null 表示输入结束（EOF / 流关闭） */
  ask(prompt: string): Promise<string | null>;
  print(line?: string): void;
}

export interface ChatOptions {
  llm: LLMClient;
  tools: ToolDefinition[];
  scope: Scope;
  role: string;
  name?: string;
  io: ChatIO;
  /** 打印过程事件，默认 true；--quiet 时关掉 */
  verbose?: boolean;
  /** 测试注入用 */
  onEvent?: (event: SessionEvent) => void;
}

export interface ChatOutcome {
  tasks: number;
  reason: "exit" | "eof";
}

const COMMANDS: Array<[string, string]> = [
  ["/help", "显示可用命令"],
  ["/reset", "清空上下文，开始新会话"],
  ["/tools", "列出当前可用工具"],
  ["/scope", "显示作用域（主机白名单 / 预算）"],
  ["/events", "显示本次会话的事件统计"],
  ["/exit", "退出（/quit、/q 同义）"],
];

export async function runChat(opts: ChatOptions): Promise<ChatOutcome> {
  const { io, llm, scope } = opts;
  const verbose = opts.verbose !== false;
  const registry = new ToolRegistry().register(...opts.tools);
  const specs = registry.specs();
  const systemPrompt = buildSystemPrompt({ role: opts.role, tools: specs, scope });

  const newSession = (): Session => {
    const session = new Session();
    session.append({ role: "system", content: systemPrompt });
    return session;
  };

  let session = newSession();
  let tasks = 0;

  const emit = (event: SessionEvent): void => {
    opts.onEvent?.(event);
    if (!verbose) return;
    const line = formatEvent(event);
    if (line) io.print(line);
  };

  const startSession = (): void => {
    const event = session.record("session.start", {
      agent: opts.name ?? "dsh",
      llm: llm.name,
      tools: specs.map((t) => t.name),
    });
    emit(event);
  };

  startSession();
  io.print("");
  io.print("输入任务开始对话；/help 查看命令，/exit 退出。");
  io.print("");

  for (;;) {
    const line = await io.ask("dsh> ");
    if (line === null) return { tasks, reason: "eof" };

    const text = line.trim();
    if (text === "") continue;

    if (text.startsWith("/")) {
      const action = handleCommand(text, { specs, scope, session });
      switch (action.kind) {
        case "exit":
          io.print("bye");
          return { tasks, reason: "exit" };
        case "reset":
          session = newSession();
          startSession();
          io.print("已清空上下文，开始新会话。");
          io.print("");
          break;
        case "print":
          io.print(action.text);
          io.print("");
          break;
        case "unknown":
          io.print(`未知命令 ${action.name}，输入 /help 查看可用命令。`);
          io.print("");
          break;
        case "none":
          break;
      }
      continue;
    }

    tasks += 1;
    session.append({ role: "user", content: text });
    session.record("user.message", { chars: text.length, preview: text.slice(0, 120) });

    const started = Date.now();
    try {
      const result = await runAgentLoop({ llm, registry, session, scope, onEvent: emit });
      io.print("");
      io.print(result.text || "（模型没有给出文本答复）");
      io.print(formatSummary(result, Date.now() - started));
      io.print("");
    } catch (err) {
      // runAgentLoop 内部已经兜住了常规错误，能走到这里说明是意外
      io.print(`x 本轮失败：${describeError(err)}`);
      io.print("");
    }
  }
}

interface CommandContext {
  specs: ToolSpec[];
  scope: Scope;
  session: Session;
}

type CommandAction =
  | { kind: "exit" | "reset" | "none" }
  | { kind: "print"; text: string }
  | { kind: "unknown"; name: string };

function handleCommand(raw: string, ctx: CommandContext): CommandAction {
  const { specs, scope, session } = ctx;
  const name = raw.split(/\s+/)[0]!.toLowerCase();
  switch (name) {
    case "/exit":
    case "/quit":
    case "/q":
      return { kind: "exit" };
    case "/reset":
    case "/clear":
      return { kind: "reset" };
    case "/help":
      return { kind: "print", text: ["命令：", ...COMMANDS.map(([cmd, desc]) => `  ${cmd.padEnd(10)}${desc}`)].join("\n") };
    case "/tools":
      return {
        kind: "print",
        text: `可用工具（${specs.length}）：\n${specs.map((t) => `  ${t.name.padEnd(14)}${t.description.slice(0, 50)}`).join("\n")}`,
      };
    case "/scope": {
      const hosts = scope.policy.allowedHosts;
      return {
        kind: "print",
        text: [
          "作用域：",
          `  主机白名单：${hosts && hosts.length > 0 ? hosts.join(", ") : "（未限制）"}`,
          `  工具白名单：${(scope.policy.allowedTools ?? []).join(", ") || "（未限制）"}`,
          `  预算：${scope.policy.maxTurns} 轮 / ${scope.policy.maxToolCalls} 次工具调用 / 单次输出 ${scope.policy.maxOutputChars} 字`,
        ].join("\n"),
      };
    }
    case "/events": {
      const counts = new Map<string, number>();
      for (const e of session.events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
      const lines = [...counts.entries()].map(([type, n]) => `  ${type.padEnd(18)}${n}`);
      return { kind: "print", text: `会话 ${session.id}（${session.messages.length} 条消息）事件：\n${lines.join("\n")}` };
    }
    default:
      return { kind: "unknown", name };
  }
}

/** 真实终端用的 IO。单独抽出来，测试可以注入假输入 */
export function createReadlineIO(): { io: ChatIO; close: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    io: {
      async ask(prompt: string): Promise<string | null> {
        try {
          return await rl.question(prompt);
        } catch {
          return null; // 流被关闭 / 被中断
        }
      },
      print(line = ""): void {
        process.stdout.write(`${line}\n`);
      },
    },
    close: () => rl.close(),
  };
}
