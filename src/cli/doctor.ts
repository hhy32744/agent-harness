/**
 * 环境与配置检查：dsh doctor。
 *
 * 目标不是"报告一切正常"，而是**在真正发请求之前**把常见坑点指出来：
 * 密钥没配、端点不通、密钥无效、out/ 写不了、ssh 主机没配。
 * 每项检查都分 ok / warn / fail 三档：
 *   - fail：一定跑不起来，退出码非 0；
 *   - warn：可能跑不起来（比如网络受限、没配密钥），但离线演示仍可用。
 * 这样 CI 里可以直接跑它当冒烟检查，不会因为没配密钥就红。
 */
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_SEARCH_ENDPOINT } from "../tools/builtin/websearch";
import { createToolset, DEFAULT_TOOL_NAMES } from "../tools/toolset";
import { describeError } from "../types";
import { resolveConfig } from "./config";
import type { RunOptions } from "./args";

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  ok: boolean;
  failed: number;
  warned: number;
}

export interface DoctorDeps {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  fetchImpl?: typeof fetch;
  nodeVersion?: string;
  sshConfigPath?: string;
  timeoutMs?: number;
  options?: RunOptions;
}

const MIN_NODE_MAJOR = 18;

export async function runDoctor(deps: DoctorDeps = {}): Promise<DoctorReport> {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const nodeVersion = deps.nodeVersion ?? process.versions.node;
  const sshConfigPath = deps.sshConfigPath ?? join(homedir(), ".ssh", "config");
  const timeoutMs = deps.timeoutMs ?? 6000;
  const options: RunOptions = deps.options ?? { hosts: [], json: false, quiet: false };

  const config = resolveConfig(options, env);
  const checks: DoctorCheck[] = [];

  // 1) Node 版本
  const major = Number(nodeVersion.split(".")[0] ?? 0);
  checks.push({
    name: "Node 版本",
    status: major >= MIN_NODE_MAJOR ? "ok" : "fail",
    detail: `v${nodeVersion}（要求 >= ${MIN_NODE_MAJOR}）`,
  });

  // 2) 密钥
  checks.push(checkApiKey(config.apiKey));

  // 3) 模型端点：带密钥请求 /models，能区分"网络不通"和"密钥无效"
  checks.push(await checkEndpoint(config.baseUrl, config.model, config.apiKey, fetchImpl, timeoutMs));

  // 4) 输出目录
  checks.push(await checkWritableOut(resolve(cwd, "out")));

  // 5) 工具集：名字拼错的话这里就会暴露，而不是等到 agent 跑起来
  checks.push(checkTools(config.tools));

  // 6) 搜索端点
  checks.push(await checkSearchEndpoint(config.searchEndpoint, fetchImpl, timeoutMs));

  // 7) ssh 主机（remote 子命令依赖）
  checks.push(await checkSshHosts(sshConfigPath));

  // 8) 生效的预算与白名单，方便对照"我以为配了"和"实际生效"
  checks.push({
    name: "运行参数",
    status: "ok",
    detail: `model=${config.model} 主机白名单=${config.hosts.length ? config.hosts.join(",") : "未限制"} 轮次<=${config.maxTurns} 工具<=${config.maxToolCalls}`,
  });

  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  return { checks, ok: failed === 0, failed, warned };
}

function checkApiKey(apiKey: string | undefined): DoctorCheck {
  if (!apiKey) {
    return {
      name: "模型密钥",
      status: "warn",
      detail: "未设置 DSH_API_KEY / DEEPSEEK_API_KEY —— 交互与 prompt 子命令需要它",
    };
  }
  return { name: "模型密钥", status: "ok", detail: mask(apiKey) };
}

function mask(secret: string): string {
  if (secret.length <= 10) return "已设置（长度不足 10，无法掩码展示）";
  return `${secret.slice(0, 4)}...${secret.slice(-4)}（长度 ${secret.length}）`;
}

async function checkEndpoint(
  baseUrl: string,
  model: string,
  apiKey: string | undefined,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<DoctorCheck> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  if (!apiKey) {
    return { name: "模型端点", status: "warn", detail: `${url} 未探测（缺少密钥）` };
  }
  try {
    const resp = await withTimeout(
      fetchImpl(url, {
        method: "GET",
        headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      }),
      timeoutMs,
    );
    if (resp.status === 401 || resp.status === 403) {
      return { name: "模型端点", status: "fail", detail: `HTTP ${resp.status}：密钥被拒绝（${url}）` };
    }
    if (!resp.ok) {
      return { name: "模型端点", status: "warn", detail: `HTTP ${resp.status}（${url}）` };
    }
    const body = (await resp.json().catch(() => undefined)) as { data?: unknown[] } | undefined;
    const count = Array.isArray(body?.data) ? body!.data!.length : undefined;
    return {
      name: "模型端点",
      status: "ok",
      detail: `HTTP 200${count === undefined ? "" : `，${count} 个可用模型`}；目标模型 ${model}`,
    };
  } catch (err) {
    return { name: "模型端点", status: "warn", detail: `无法连通 ${url}：${describeError(err)}` };
  }
}

async function checkWritableOut(outDir: string): Promise<DoctorCheck> {
  const probe = join(outDir, `.doctor-${process.pid}-${Date.now()}.tmp`);
  try {
    await mkdir(outDir, { recursive: true });
    await writeFile(probe, "ok", "utf8");
    await unlink(probe);
    return { name: "输出目录", status: "ok", detail: `${outDir} 可写（save_markdown 落盘位置）` };
  } catch (err) {
    return { name: "输出目录", status: "fail", detail: `${outDir} 不可写：${describeError(err)}` };
  }
}

function checkTools(names: string[]): DoctorCheck {
  try {
    const tools = createToolset(names.length ? names : DEFAULT_TOOL_NAMES);
    return { name: "工具集", status: "ok", detail: `${tools.length} 个：${tools.map((t) => t.name).join(", ")}` };
  } catch (err) {
    return { name: "工具集", status: "fail", detail: describeError(err) };
  }
}

async function checkSearchEndpoint(
  endpoint: string | undefined,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<DoctorCheck> {
  const target = endpoint ?? process.env.DSH_SEARCH_ENDPOINT ?? DEFAULT_SEARCH_ENDPOINT;
  try {
    const resp = await withTimeout(
      fetchImpl(`${target}${target.includes("?") ? "&" : "?"}q=test`, {
        method: "GET",
        headers: { accept: "text/html" },
      }),
      timeoutMs,
    );
    return {
      name: "搜索端点",
      status: resp.ok ? "ok" : "warn",
      detail: `HTTP ${resp.status}（${target}）${resp.ok ? "" : "；被拦截时可换 DSH_SEARCH_ENDPOINT"}`,
    };
  } catch (err) {
    return {
      name: "搜索端点",
      status: "warn",
      detail: `无法连通 ${target}：${describeError(err)}；web_search 不可用，其余工具不受影响`,
    };
  }
}

async function checkSshHosts(configPath: string): Promise<DoctorCheck> {
  try {
    const text = await readFile(configPath, "utf8");
    const hosts = parseSshHosts(text);
    if (hosts.length === 0) {
      return { name: "SSH 主机", status: "warn", detail: `${configPath} 里没有 Host 条目，remote 子命令无处可连` };
    }
    return {
      name: "SSH 主机",
      status: "ok",
      detail: `${hosts.length} 个：${hosts.slice(0, 8).join(", ")}${hosts.length > 8 ? " ..." : ""}`,
    };
  } catch (err) {
    return { name: "SSH 主机", status: "warn", detail: `读不到 ${configPath}：${describeError(err)}` };
  }
}

/** 从 ssh config 里抽 Host 别名，跳过只含通配符的规则 */
export function parseSshHosts(text: string): string[] {
  const hosts: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*Host\s+(.+?)\s*(?:#.*)?$/i.exec(line);
    if (!m) continue;
    for (const name of m[1]!.split(/\s+/)) {
      if (!name || name.includes("*") || name.includes("?") || name.includes("!")) continue;
      hosts.push(name);
    }
  }
  return [...new Set(hosts)];
}

const LABEL: Record<CheckStatus, string> = { ok: "ok  ", warn: "warn", fail: "FAIL" };

export function formatDoctor(report: DoctorReport): string[] {
  const lines = report.checks.map((c) => `[${LABEL[c.status]}] ${c.name}：${c.detail}`);
  lines.push("");
  lines.push(`结果：${report.checks.length - report.failed - report.warned} 通过 / ${report.warned} 警告 / ${report.failed} 失败`);
  if (report.warned > 0) lines.push("（警告不阻塞；加上 --strict 可让警告也返回非 0 退出码）");
  return lines;
}

/** 与 fetch 超时赛跑：注入的 fetch 可能不理 signal，所以不能只靠 signal */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`超过 ${ms}ms 未响应`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
