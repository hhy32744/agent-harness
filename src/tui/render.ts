/**
 * TUI 渲染层：把 SessionEvent / LoopResult 变成终端上人看的行。
 *
 * 与 cli/render.ts 的区别：那边是"日志流"（-> / <- / =），这边是"会话界面"
 * （▶ 用户 / ● 工具 / 本轮完成 / 状态栏），更接近课程示例里的终端交互形态。
 * 渲染函数全部是纯函数或小状态机，不碰 stdin/stdout，因此可离线断言。
 */
import type { SessionEvent } from "../session";
import type { LoopResult } from "../agent-loop";

/** 极简 ANSI：只在 color=true 时上色，测试 / 重定向时保持纯文本 */
export interface Palette {
  cyan(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  gray(s: string): string;
  bold(s: string): string;
  reset: string;
}

const PLAIN: Palette = {
  cyan: (s) => s,
  green: (s) => s,
  yellow: (s) => s,
  gray: (s) => s,
  bold: (s) => s,
  reset: "",
};

const ANSI: Palette = {
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  gray: (s) => `\x1b[90m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  reset: "\x1b[0m",
};

export function palette(color: boolean): Palette {
  return color ? ANSI : PLAIN;
}

/** 课程示例里的 DSH 字样：用纯 ASCII 画，任何终端字体都能看 */
export const DSH_BANNER = [
  "DDDD  SSSSS  H   H",
  "D   D S      H   H",
  "D   D SSSSS  HHHHH",
  "D   D     S  H   H",
  "DDDD  SSSSS  H   H",
].join("\n");

export interface BannerInfo {
  agent?: string;
  llm?: string;
  preset?: string;
  version?: string;
}

/** 顶部：ASCII + 标题 + 快捷键提示 */
export function renderBanner(info: BannerInfo, p: Palette = PLAIN): string {
  const lines = [
    p.cyan(DSH_BANNER),
    "",
    ` ${p.bold(info.agent ?? "agent-harness")}`,
  ];
  const meta: string[] = [];
  if (info.llm) meta.push(info.llm);
  if (info.preset) meta.push(`preset=${info.preset}`);
  if (info.version) meta.push(`v${info.version}`);
  if (meta.length) lines.push(` ${p.gray(meta.join(" · "))}`);
  lines.push("");
  lines.push(` ${p.gray("/help 帮助 · Esc 取消 · <Ctrl+C> 强制退出")}`);
  return lines.join("\n");
}

/** 用户那一轮：▶ 开头 */
export function renderUser(text: string, p: Palette = PLAIN): string {
  return `${p.yellow("▶")} ${text}`;
}

export function toolLabel(name: string): string {
  // 课程示例显示 web-search；内核叫 web_search，这里做展示层映射
  return name.replace(/_/g, "-");
}

export interface RenderState {
  /** callId -> 起始毫秒，用于算耗时 */
  started: Map<string, number>;
  toolCalls: number;
  toolErrors: number;
  pending: number;
  cacheHits: number;
}

export function newRenderState(): RenderState {
  return { started: new Map(), toolCalls: 0, toolErrors: 0, pending: 0, cacheHits: 0 };
}

/**
 * 事件 → 展示行。返回 null 表示该事件在界面上不单独占一行。
 * 时间戳用事件自带 ts（Session.record 打的），所以耗时是真实墙钟。
 */
export function renderEvent(event: SessionEvent, state: RenderState, p: Palette = PLAIN): string | null {
  const d = event.data;
  switch (event.type) {
    case "user.message":
      return null; // 交互里由 renderUser 显示
    case "session.start":
      return null;
    case "tool.call": {
      const callId = String(d.callId ?? "");
      state.started.set(callId, event.ts);
      state.toolCalls += 1;
      state.pending += 1;
      const args = JSON.stringify(d.args ?? {});
      return ` ${p.green("●")} ${p.cyan(toolLabel(String(d.name)))} ${p.gray(args.slice(0, 160))}`;
    }
    case "tool.note": {
      const name = String(d.event ?? "");
      if (name === "search.cache") {
        state.cacheHits += 1;
        return `   ${p.gray("· 缓存命中")}`;
      }
      return null;
    }
    case "tool.result": {
      const callId = String(d.callId ?? "");
      const start = state.started.get(callId);
      const ms = start === undefined ? 0 : event.ts - start;
      state.pending = Math.max(0, state.pending - 1);
      if (d.isError) state.toolErrors += 1;
      const badge = d.isError ? p.yellow("失败") : p.gray("ok");
      return `   ${p.gray("└")} ${badge} ${p.gray(`${ms} ms`)}`;
    }
    case "tool.denied":
      return ` ${p.yellow("!")} 工具被拒：${p.gray(String(d.reason ?? ""))}`;
    case "error":
      return ` ${p.yellow("×")} ${String(d.message ?? "")}`;
    case "turn.limit":
      return ` ${p.yellow("!")} 预算用尽：${p.gray(JSON.stringify(d))}`;
    default:
      return null;
  }
}

/** 最终答复块 */
export function renderAnswer(text: string, p: Palette = PLAIN): string {
  return text.trim() ? text : `${p.gray("（模型没有给出文本答复）")}`;
}

/** 一轮收尾：本轮完成 + 状态栏 + 会话落盘路径 */
export function renderDone(
  result: LoopResult,
  elapsedMs: number,
  opts: { model?: string; sessionPath?: string; cacheHits?: number; pending?: number },
  p: Palette = PLAIN,
): string {
  const statusModel = opts.model ?? "unknown/unknown";
  const cache = p.gray(opts.cacheHits ? `缓存 ${opts.cacheHits}` : "缓存");
  const pending = p.gray(`待处理 ${opts.pending ?? 0}`);
  const usage = result.usage.totalTokens > 0 ? ` · token ${result.usage.totalTokens}` : "";
  const lines = [
    "",
    p.green("本轮完成"),
    "─".repeat(56),
    `${p.cyan(statusModel)} · ${cache} · ${pending}${usage} · ${elapsedMs}ms`,
  ];
  if (opts.sessionPath) lines.push(`${p.gray("session")} ${opts.sessionPath}`);
  return lines.join("\n");
}

/** 斜杠命令帮助 */
export function renderHelp(p: Palette = PLAIN): string {
  const rows: Array<[string, string]> = [
    ["/help", "显示帮助"],
    ["/preset", "显示/切换预设：/preset [id]"],
    ["/tools", "列出当前工具"],
    ["/scope", "显示运行边界"],
    ["/reset", "清空上下文，开始新会话"],
    ["/exit", "退出（/quit、/q 同义）"],
  ];
  return ["命令：", ...rows.map(([c, d]) => `  ${p.cyan(c.padEnd(10))}${d}`)].join("\n");
}
