/**
 * TUI 交互驱动：把渲染层接上 agent loop。
 *
 * 与 cli/chat.ts 共用同一套内核（Session / ToolRegistry / runAgentLoop），
 * 区别只在"呈现层"：这里按课程示例的样子画 banner、工具时间线、状态栏。
 * 支持 Esc 取消当前轮、Ctrl+C 强制退出；会话每轮落盘为 session.jsonl。
 */
import { createInterface } from "node:readline/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { runAgentLoop, type LoopResult } from "../agent-loop";
import type { LLMClient } from "../llm/types";
import type { PresetManager } from "../preset";
import type { Scope } from "../scope";
import { Session, type SessionEvent } from "../session";
import { buildSystemPrompt } from "../system-prompt";
import { ToolRegistry } from "../tools/registry";
import type { ToolDefinition } from "../tools/types";
import { describeError } from "../types";
import {
  newRenderState,
  palette,
  renderAnswer,
  renderBanner,
  renderDone,
  renderEvent,
  renderHelp,
  renderUser,
} from "./render";

export interface TuiIO {
  ask(prompt: string): Promise<string | null>;
  print(line?: string): void;
  /** 可选：安装一个只在"任务执行中"生效的原始按键监听（Esc 取消） */
  withAbortListener?<T>(onAbort: () => void, fn: () => Promise<T>): Promise<T>;
}

export interface TuiOptions {
  llm: LLMClient;
  tools: ToolDefinition[];
  scope: Scope;
  role: string;
  name?: string;
  version?: string;
  io: TuiIO;
  presetManager: PresetManager;
  /** 预设解析出的额外规则，进入 system prompt */
  extraRules?: string[];
  /** 搜索端点说明，用于状态展示 */
  searchEndpoint?: string;
  color?: boolean;
  /** 会话落盘目录；不传则 ~/.dsh/sessions */
  sessionDir?: string;
  onEvent?: (event: SessionEvent) => void;
}

export interface TuiOutcome {
  tasks: number;
  reason: "exit" | "eof" | "aborted";
  sessionPath?: string;
}

/** 真实终端 IO：readline 输入 + 执行期的 Esc 监听 */
export function createTuiIO(): { io: TuiIO; close: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const stdin = process.stdin;
  return {
    io: {
      async ask(prompt: string): Promise<string | null> {
        try {
          return await rl.question(prompt);
        } catch {
          return null;
        }
      },
      print(line = ""): void {
        process.stdout.write(`${line}\n`);
      },
      async withAbortListener<T>(onAbort: () => void, fn: () => Promise<T>): Promise<T> {
        // 非 TTY（管道 / IDE 输出面板）没有 Esc 的概念，直接跑
        if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
          return fn();
        }
        const wasRaw = stdin.isRaw;
        const onData = (chunk: Buffer | string): void => {
          const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
          if (s.includes("\x1b")) onAbort(); // Esc
        };
        stdin.setRawMode(true);
        stdin.on("data", onData);
        try {
          return await fn();
        } finally {
          stdin.off("data", onData);
          stdin.setRawMode(Boolean(wasRaw));
        }
      },
    },
    close: () => rl.close(),
  };
}

function sessionFile(dir: string, sessionId: string): string {
  return join(dir, sessionId.replace(/[^A-Za-z0-9_-]/g, "_"), "session.jsonl");
}

/** 把整段会话快照写成 JSONL：一行事件 + 一行最终快照，便于复盘/评分 */
async function persistSession(path: string, session: Session): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const lines = [
    ...session.events.map((e) => JSON.stringify({ kind: "event", ...e })),
    JSON.stringify({ kind: "snapshot", ...session.snapshot() }),
  ];
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
}

export async function runTui(opts: TuiOptions): Promise<TuiOutcome> {
  const { io, llm, scope, presetManager } = opts;
  const p = palette(opts.color !== false && Boolean(process.stdout.isTTY));
  const dir = opts.sessionDir ?? join(homedir(), ".dsh", "sessions");
  const registry = new ToolRegistry().register(...opts.tools);
  const specs = registry.specs();
  const active = presetManager.active;

  if (!active) throw new Error("没有任何启用的预设，无法启动 TUI");
  const displayModel = `${llm.name}/${"model" in llm ? String((llm as { model?: unknown }).model ?? "") : ""}`.replace(/\/$/, "");

  const buildPrompt = (): string =>
    buildSystemPrompt({
      role: opts.role,
      tools: specs,
      scope,
      extraRules: opts.extraRules,
    });

  const newSession = (): Session => {
    const s = new Session();
    s.append({ role: "system", content: buildPrompt() });
    return s;
  };

  let session = newSession();
  let tasks = 0;
  let state = newRenderState();
  let sessionPath: string | undefined;

  // 会话启动事件（记录一次，不单独显示）
  session.record("session.start", {
    agent: opts.name ?? "dsh",
    llm: llm.name,
    preset: active.id,
    tools: specs.map((t) => t.name),
  });

  io.print(renderBanner(
    {
      agent: opts.name ?? "agent-harness",
      llm: displayModel,
      preset: active.name,
      version: opts.version,
    },
    p,
  ));
  io.print("");
  io.print(` ${p.gray("输入任务开始对话；/preset 可切换预设；/exit 退出。")}`);
  io.print("");

  for (;;) {
    const line = await io.ask(p.cyan("> "));
    if (line === null) return { tasks, reason: "eof", sessionPath };
    const text = line.trim();
    if (text === "") continue;

    if (text.startsWith("/")) {
      const action = handleCommand(text, { presetManager, registry, scope, session, io, p });
      if (action === "exit") {
        io.print("bye");
        return { tasks, reason: "exit", sessionPath };
      }
      if (action === "reset") {
        session = newSession();
        session.record("session.start", { agent: opts.name ?? "dsh", preset: presetManager.active?.id });
        state = newRenderState();
        sessionPath = undefined;
        io.print(p.gray("已清空上下文，开始新会话。"));
        io.print("");
      }
      continue;
    }

    tasks += 1;
    io.print(renderUser(text, p));
    session.append({ role: "user", content: text });
    session.record("user.message", { chars: text.length, preview: text.slice(0, 120) });

    const started = Date.now();
    const controller = new AbortController();
    const emit = (event: SessionEvent): void => {
      opts.onEvent?.(event);
      const lineOut = renderEvent(event, state, p);
      if (lineOut) io.print(lineOut);
    };

    let result: LoopResult;
    try {
      const body = (): Promise<LoopResult> =>
        runAgentLoop({ llm, registry, session, scope, signal: controller.signal, onEvent: emit });
      result = io.withAbortListener
        ? await io.withAbortListener(() => controller.abort(new Error("Esc 取消")), body)
        : await body();
    } catch (err) {
      io.print(` ${p.yellow("×")} 本轮异常：${describeError(err)}`);
      io.print("");
      continue;
    }

    io.print("");
    io.print(renderAnswer(result.text, p));

    // 落盘会话快照
    const target = sessionFile(dir, session.id);
    try {
      await persistSession(target, session);
      sessionPath = target;
    } catch (err) {
      io.print(` ${p.yellow("!")} 会话落盘失败：${describeError(err)}`);
    }

    io.print(renderDone(result, Date.now() - started, {
      model: displayModel,
      sessionPath,
      cacheHits: state.cacheHits,
      pending: state.pending,
    }, p));
    io.print("");
  }
}

type CommandResult = "exit" | "reset" | "none";

function handleCommand(
  raw: string,
  ctx: {
    presetManager: PresetManager;
    registry: ToolRegistry;
    scope: Scope;
    session: Session;
    io: TuiIO;
    p: ReturnType<typeof palette>;
  },
): CommandResult {
  const [name, arg] = raw.split(/\s+/);
  const { presetManager, registry, scope, session, io, p } = ctx;
  switch (name?.toLowerCase()) {
    case "/exit":
    case "/quit":
    case "/q":
      return "exit";
    case "/reset":
    case "/clear":
      return "reset";
    case "/help":
      io.print(renderHelp(p));
      io.print("");
      return "none";
    case "/tools":
      io.print(`可用工具（${registry.size}）：\n${registry.specs().map((t) => `  ${t.name}`).join("\n")}`);
      io.print("");
      return "none";
    case "/scope":
      io.print([
        "运行边界：",
        `  工具白名单：${scope.policy.allowedTools?.join(", ") || "（未限制）"}`,
        `  主机白名单：${scope.policy.allowedHosts?.join(", ") || "（未限制）"}`,
        `  预算：${scope.policy.maxTurns} 轮 / ${scope.policy.maxToolCalls} 次工具`,
      ].join("\n"));
      io.print("");
      return "none";
    case "/preset": {
      if (arg) {
        try {
          presetManager.use(arg);
          io.print(p.green(`已切换预设：${presetManager.active?.name} (${arg})`));
          io.print(p.gray("提示：新预设对人设/工具的改动在 /reset 后完全生效。"));
        } catch (err) {
          io.print(p.yellow(`切换失败：${describeError(err)}`));
        }
      } else {
        const rows = presetManager.list().map((x) => {
          const mark = x.id === presetManager.active?.id ? "*" : " ";
          const on = x.enabled ? "on" : "off";
          return ` ${p.green(mark)} ${x.id.padEnd(22)} ${on.padEnd(4)} ${x.name}`;
        });
        io.print(`预设（当前：${presetManager.active?.name ?? "无"}）：\n${rows.join("\n")}`);
      }
      io.print("");
      return "none";
    }
    default:
      io.print(`未知命令 ${name}，输入 /help 查看。`);
      io.print("");
      return "none";
  }
}
