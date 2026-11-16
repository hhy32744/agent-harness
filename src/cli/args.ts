/**
 * 命令行解析：纯函数，不碰 IO，方便直接单测。
 *
 * 支持的命令：
 *   dsh                              启动交互式聊天
 *   dsh prompt <任务文本>            启动一个非交互任务
 *   dsh read <url>                   直接调用 fetch_url 读一个页面（不需要模型 key）
 *   dsh doctor                       环境与配置检查
 *   dsh remote <host> --prompt <文本> 在远端起一个任务，跑完把结果带回来
 */

export class UsageError extends Error {
  readonly hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = "UsageError";
    this.hint = hint;
  }
}

/** 各子命令共享的运行参数 */
export interface RunOptions {
  model?: string;
  baseUrl?: string;
  /** 抓取主机白名单；空数组表示不限制 */
  hosts: string[];
  /** 覆盖工具集，例如 "web_search,fetch_url" */
  tools?: string[];
  maxTurns?: number;
  maxToolCalls?: number;
  role?: string;
  /** 机器可读输出 */
  json: boolean;
  quiet: boolean;
}

export type Command =
  | { kind: "chat"; options: RunOptions }
  | { kind: "prompt"; task: string; options: RunOptions }
  | { kind: "read"; url: string; raw: boolean; full: boolean; maxBytes?: number; options: RunOptions }
  | { kind: "doctor"; json: boolean; strict: boolean; options: RunOptions }
  | { kind: "remote"; host: string; prompt?: string; options: RunOptions }
  | { kind: "help" }
  | { kind: "version" };

const VERSION = "0.1.0";

export function version(): string {
  return VERSION;
}

/** 需要取值的开关；其余 `--xxx` 一律当布尔开关 */
const VALUE_FLAGS = new Set([
  "model",
  "base-url",
  "allow-host",
  "tools",
  "max-turns",
  "max-tool-calls",
  "max-bytes",
  "role",
  "prompt",
]);

interface FlagBag {
  positionals: string[];
  flags: Map<string, string | true>;
}

function readFlags(argv: readonly string[]): FlagBag {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;

    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token === "-h") {
      flags.set("help", true);
      continue;
    }
    if (token === "-v" || token === "-V") {
      flags.set("version", true);
      continue;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const body = token.slice(2);
    const eq = body.indexOf("=");
    const name = eq === -1 ? body : body.slice(0, eq);
    if (name === "") throw new UsageError(`非法参数 ${token}`);

    if (eq !== -1) {
      if (!VALUE_FLAGS.has(name)) throw new UsageError(`参数 --${name} 不接受取值`);
      flags.set(name, body.slice(eq + 1));
      continue;
    }

    if (VALUE_FLAGS.has(name)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`参数 --${name} 缺少取值`, `例如 --${name}=<值>`);
      }
      flags.set(name, value);
      i += 1;
      continue;
    }

    const known = ["json", "quiet", "strict", "help", "version", "follow", "raw", "full"];
    if (!known.includes(name)) throw new UsageError(`未知参数 --${name}`, "运行 dsh help 查看全部参数");
    flags.set(name, true);
  }

  return { positionals, flags };
}

function str(flags: Map<string, string | true>, name: string): string | undefined {
  const v = flags.get(name);
  if (v === undefined || v === true) return undefined;
  return v.trim() === "" ? undefined : v.trim();
}

function bool(flags: Map<string, string | true>, name: string): boolean {
  return flags.get(name) === true;
}

function int(flags: Map<string, string | true>, name: string): number | undefined {
  const raw = str(flags, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`--${name} 必须是正整数，收到 ${raw}`);
  return n;
}

/** `--allow-host a.com,https://b.com/x` → ["a.com", "b.com"] */
export function parseHosts(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(/[,，\s]+/)) {
    const item = part.trim();
    if (!item) continue;
    out.push(toHost(item));
  }
  return [...new Set(out)];
}

function toHost(input: string): string {
  // 用户可能直接粘贴整条 URL，这里只取主机名；`*.a.com` 这类通配保持原样
  if (input.includes("://")) {
    try {
      return new URL(input).hostname.toLowerCase();
    } catch {
      return input.toLowerCase();
    }
  }
  const slash = input.indexOf("/");
  return (slash === -1 ? input : input.slice(0, slash)).toLowerCase();
}

function readOptions(flags: Map<string, string | true>): RunOptions {
  const tools = str(flags, "tools");
  return {
    model: str(flags, "model"),
    baseUrl: str(flags, "base-url"),
    hosts: parseHosts(str(flags, "allow-host")),
    tools: tools ? tools.split(/[,，\s]+/).filter(Boolean) : undefined,
    maxTurns: int(flags, "max-turns"),
    maxToolCalls: int(flags, "max-tool-calls"),
    role: str(flags, "role"),
    json: bool(flags, "json"),
    quiet: bool(flags, "quiet"),
  };
}

export function parseArgv(argv: readonly string[]): Command {
  const { positionals, flags } = readFlags(argv);

  if (bool(flags, "help") && positionals.length === 0) return { kind: "help" };
  if (bool(flags, "version")) return { kind: "version" };

  const options = readOptions(flags);
  const [head, ...rest] = positionals;

  if (head === undefined) return { kind: "chat", options };

  switch (head) {
    case "chat":
    case "repl":
      if (rest.length > 0) throw new UsageError(`chat 不接受位置参数：${rest.join(" ")}`, "要跑一次任务请用 dsh prompt <文本>");
      return { kind: "chat", options };

    case "prompt": {
      const task = rest.join(" ").trim();
      if (!task) throw new UsageError("prompt 需要任务文本", '例如 dsh prompt "抓取 example.com 首页并总结"');
      return { kind: "prompt", task, options };
    }

    case "read": {
      const url = rest[0];
      if (!url) throw new UsageError("read 需要一个 URL", "例如 dsh read https://example.com/");
      if (rest.length > 1) throw new UsageError(`read 只接受一个 URL，多余的：${rest.slice(1).join(" ")}`);
      return {
        kind: "read",
        url,
        raw: bool(flags, "raw"),
        full: bool(flags, "full"),
        maxBytes: int(flags, "max-bytes"),
        options,
      };
    }

    case "doctor":
      if (rest.length > 0) throw new UsageError(`doctor 不接受位置参数：${rest.join(" ")}`);
      return { kind: "doctor", json: bool(flags, "json"), strict: bool(flags, "strict"), options };

    case "remote": {
      const host = rest[0];
      if (!host) throw new UsageError("remote 需要目标主机", "例如 dsh remote 4090 --prompt \"检查 GPU 占用\"");
      if (rest.length > 1) throw new UsageError(`remote 只接受一个主机名，多余的：${rest.slice(1).join(" ")}`);
      return { kind: "remote", host, prompt: str(flags, "prompt"), options };
    }

    case "help":
      return { kind: "help" };

    case "version":
      return { kind: "version" };

    default:
      throw new UsageError(`未知子命令 ${head}`, "可用：dsh / dsh prompt / dsh read / dsh doctor / dsh remote");
  }
}

export const HELP_TEXT = `dsh —— 由大模型驱动的网页爬取 agent

用法：
  dsh                                  启动交互式聊天（多轮，同一会话保留上下文）
  dsh prompt "<任务文本>"               启动一个非交互任务，跑完打印结果
  dsh read <url>                       直接读一个网页并打印正文（不调用模型，不需要 key）
  dsh doctor                           检查 Node / 密钥 / 模型端点 / 目录 / 工具 / SSH
  dsh remote <host> [--prompt "<文本>"] 在远端执行任务（走 ssh，不带 --prompt 则开远端交互）

read 专用参数：
  --raw                   打印原始 HTML，不做正文提取
  --full                  不截断正文（默认只显示前 4000 字符）
  --max-bytes <n>         最多读多少字节，默认 262144，上限 524288

通用参数：
  --model <name>          模型名，默认取 DSH_MODEL / DEEPSEEK_MODEL，再退到 deepseek-chat
  --base-url <url>        OpenAI 兼容端点，默认 https://api.deepseek.com
  --allow-host <hosts>    抓取主机白名单，逗号分隔，支持 *.example.com；不填则不限
  --tools <names>         限定可用工具，默认 web_search,fetch_url,extract_links,save_markdown
  --max-turns <n>         agent 最大轮次，默认 8
  --max-tool-calls <n>    单次任务最大工具调用次数，默认 16
  --json                  输出机器可读 JSON（prompt / read / doctor）
  --quiet                 只打印最终结果，不打印过程事件
  -h, --help              显示本帮助
  -v, --version           显示版本

环境变量：
  DSH_API_KEY / DEEPSEEK_API_KEY  模型密钥（二者都可，前者优先）
  DSH_BASE_URL / DSH_MODEL        端点与模型
  DSH_SEARCH_ENDPOINT             web_search 的搜索页地址
  DSH_REMOTE_BIN                  remote 子命令在远端执行的命令名，默认 dsh

示例：
  dsh read https://example.com/                    # 不配 key 也能跑，验网络读取能力
  dsh read https://example.com/ --raw --max-bytes 4096
  dsh doctor
  dsh prompt "搜索 agent 的最新进展，挑 3 条总结" --allow-host api.deepseek.com
  dsh remote 4090 --prompt "查看 GPU 状态并汇总"
  dsh --allow-host example.com
`;
