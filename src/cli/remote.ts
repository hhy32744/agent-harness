/**
 * remote：在另一台机器上跑同一个 dsh，然后把结果带回来。
 *
 * 实现刻意选最土的方式 —— 一条 ssh 命令：
 *     ssh <host> '<远端命令>'
 * 不引入常驻服务、不做端口转发。理由：远端只需要装好 dsh 和密钥，
 * 本机不需要知道远端目录、Python 路径、GPU 编号，运维成本最低。
 *
 * 安全点：任务文本由用户提供，必须整体当**参数**传，不能拼进 shell 后裸奔，
 * 所以统一走 shellQuote（单引号 + 内嵌单引号转义），再交给远端 shell 解析。
 */
import { spawn } from "node:child_process";

export interface RemotePlan {
  kind: "prompt" | "chat";
  /** kind=prompt 时必填 */
  task?: string;
}

export interface RemoteCommandOptions {
  /** 远端要执行的命令名，默认 dsh */
  bin: string;
  hosts?: string[];
  model?: string;
  baseUrl?: string;
  maxTurns?: number;
  maxToolCalls?: number;
  /** 让远端输出 JSON，便于本地脚本解析 */
  json?: boolean;
}

/** POSIX 单引号转义：只有"完全安全"的字符才不加引号 */
export function shellQuote(value: string): string {
  if (value === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildRemoteCommand(plan: RemotePlan, options: RemoteCommandOptions): string {
  const parts: string[] = [options.bin];
  if (plan.kind === "prompt") {
    if (!plan.task) throw new Error("remote 的 prompt 模式需要任务文本");
    parts.push("prompt", plan.task);
  }
  if (options.json) parts.push("--json");
  if (options.hosts && options.hosts.length > 0) parts.push("--allow-host", options.hosts.join(","));
  if (options.model) parts.push("--model", options.model);
  if (options.baseUrl) parts.push("--base-url", options.baseUrl);
  if (options.maxTurns) parts.push("--max-turns", String(options.maxTurns));
  if (options.maxToolCalls) parts.push("--max-tool-calls", String(options.maxToolCalls));
  return parts.map(shellQuote).join(" ");
}

export interface SshArgvOptions {
  /** 远端交互需要分配 TTY */
  interactive?: boolean;
  sshBin?: string;
  /** 便于测试注入，例如 -p 2222 */
  extraArgs?: string[];
}

export function buildSshArgv(host: string, remoteCommand: string, options: SshArgvOptions = {}): string[] {
  const argv = [options.sshBin ?? "ssh"];
  if (options.interactive) argv.push("-t");
  if (options.extraArgs) argv.push(...options.extraArgs);
  // `--` 之后不会再被当成选项，防止 host 名以 - 开头被 ssh 误解析
  argv.push("--", host, remoteCommand);
  return argv;
}

export interface SshResult {
  code: number;
}

/** 直接继承 stdio：远端的输出原样流到本地终端，不需要中间转发 */
export function runSsh(argv: readonly string[]): Promise<SshResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: "inherit" });
    child.on("error", (err) => {
      reject(new Error(`启动 ${argv[0]} 失败：${err.message}（远端执行需要本机有 ssh 客户端）`));
    });
    child.on("close", (code) => resolvePromise({ code: code ?? 1 }));
  });
}
