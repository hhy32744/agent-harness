/**
 * 配置解析：把「命令行参数 + 环境变量 + 默认值」压成一份不可变的运行配置。
 *
 * 优先级：命令行 > 环境变量 > 内置默认。
 * 所有取默认值的地方都在这里，其它模块不许再各自读 process.env —— 否则
 * doctor 检查的和实际跑的对不上，是最难查的一类问题。
 */
import { Scope } from "../scope";
import { PresetManager, defaultPresetFile } from "../preset";
import { OpenAICompatibleClient } from "../llm/openai-client";
import type { LLMClient } from "../llm/types";
import type { ToolDefinition } from "../tools/types";
import { createToolset, DEFAULT_TOOL_NAMES } from "../tools/toolset";
import type { RunOptions } from "./args";

export interface CliConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
  maxTurns: number;
  maxToolCalls: number;
  maxOutputChars: number;
  toolTimeoutMs: number;
  /** 抓取主机白名单，空数组 = 不限制 */
  hosts: string[];
  tools: string[];
  role: string;
  /** 搜索端点；undefined 交给工具自己取环境变量/默认值 */
  searchEndpoint?: string;
  /** remote 子命令在远端执行的命令名 */
  remoteBin: string;
  /** 本次生效的预设（解析后的配置），没有则为 undefined */
  preset?: {
    id: string;
    name: string;
    role?: string;
    extraRules: string[];
  };
}

const DEFAULTS = {
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-chat",
  maxTurns: 4,
  maxToolCalls: 16,
  maxOutputChars: 6000,
  toolTimeoutMs: 15000,
  role: "网页检索与信息抽取助手",
  remoteBin: "dsh",
} as const;

/**
 * 阿里云灵积的 OpenAI 兼容模式：只需一个 key，端点与默认模型自动推导。
 * 默认选 Flash 而非 Plus：实测同样能正确发起 tool_calls，价格低一个数量级。
 *
 * 2026-11-26 实测（同一「搜特朗普政策」任务）：
 *   - qwen3.7-flash：连搜 8 轮不收敛，上下文堆爆后兜底请求 60s 超时（67s 空手而归）
 *   - qwen3.6-flash：4 轮收敛出答案，约 20s，flash 档便宜
 *   - qwen-plus：4 轮收敛、答案最完整，约 18s，但贵一个数量级
 * 故默认改用 qwen3.6-flash：便宜 + 收敛快 + 不超时，性价比最优。
 * qwen-plus / qwen4-max 可用 DSH_MODEL 或 --model 随时切回。
 */
const DASHSCOPE_DEFAULTS = {
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  model: "qwen3.6-flash",
} as const;

export function resolveConfig(options: RunOptions, env: NodeJS.ProcessEnv = process.env): CliConfig {
  const apiKey = pick(env.DSH_API_KEY, env.DEEPSEEK_API_KEY, env.DASHSCOPE_API_KEY);

  // 只有当密钥确实来自 DashScope（没有更高优先级的 key）时，才切换默认端点与模型。
  // 显式指定的 DSH_* / DEEPSEEK_* 以及命令行参数仍然优先，下面照常覆盖。
  const fromDashscope = apiKey !== undefined && pick(env.DSH_API_KEY, env.DEEPSEEK_API_KEY) === undefined;
  const defaultBaseUrl = fromDashscope ? DASHSCOPE_DEFAULTS.baseUrl : DEFAULTS.baseUrl;
  const defaultModel = fromDashscope ? DASHSCOPE_DEFAULTS.model : DEFAULTS.model;

  // 预设解析：显式 --preset > DSH_PRESET > 文件里激活的预设。
  // 预设只提供"默认值"，命令行显式参数（--tools/--role/--max-turns…）始终优先。
  const manager = PresetManager.loadSync(defaultPresetFile(env));
  const presetId = options.preset ?? pick(env.DSH_PRESET);
  const resolved = presetId ? manager.resolve({ id: presetId, universe: DEFAULT_TOOL_NAMES }) : manager.resolve({ universe: DEFAULT_TOOL_NAMES });
  const presetTools = resolved?.toolNames;
  const tools = (options.tools && options.tools.length > 0 ? options.tools : presetTools ?? [...DEFAULT_TOOL_NAMES]).map((t) => t.trim());

  const scopeFromPreset = resolved?.scope ?? {};
  return {
    apiKey,
    baseUrl: options.baseUrl ?? pick(env.DSH_BASE_URL, env.DEEPSEEK_BASE_URL) ?? defaultBaseUrl,
    model: options.model ?? pick(env.DSH_MODEL, env.DEEPSEEK_MODEL) ?? defaultModel,
    maxTurns: options.maxTurns ?? scopeFromPreset.maxTurns ?? DEFAULTS.maxTurns,
    maxToolCalls: options.maxToolCalls ?? scopeFromPreset.maxToolCalls ?? DEFAULTS.maxToolCalls,
    maxOutputChars: scopeFromPreset.maxOutputChars ?? DEFAULTS.maxOutputChars,
    toolTimeoutMs: scopeFromPreset.toolTimeoutMs ?? DEFAULTS.toolTimeoutMs,
    hosts: options.hosts,
    tools,
    role: options.role ?? resolved?.role ?? DEFAULTS.role,
    searchEndpoint: resolved?.searchEndpoint ?? pick(env.DSH_SEARCH_ENDPOINT),
    remoteBin: pick(env.DSH_REMOTE_BIN) ?? DEFAULTS.remoteBin,
    preset: resolved ? { id: resolved.id, name: resolved.name, role: resolved.role, extraRules: resolved.extraRules } : undefined,
  };
}

function pick(...values: Array<string | undefined>): string | undefined {
  for (const v of values) {
    if (v !== undefined && v.trim() !== "") return v.trim();
  }
  return undefined;
}

/** 作用域：工具白名单 + 主机白名单 + 成本闸门，一次配齐 */
export function createScope(config: CliConfig): Scope {
  return new Scope({
    allowedTools: config.tools,
    allowedHosts: config.hosts.length > 0 ? config.hosts : undefined,
    maxTurns: config.maxTurns,
    maxToolCalls: config.maxToolCalls,
    maxOutputChars: config.maxOutputChars,
    toolTimeoutMs: config.toolTimeoutMs,
  });
}

export function createTools(config: CliConfig): ToolDefinition[] {
  return createToolset(config.tools, { searchEndpoint: config.searchEndpoint });
}

/** 给 preset 子命令 / TUI 用：加载同一份预设文件，保证和 resolveConfig 看到的是同一份状态 */
export function loadPresetManager(env: NodeJS.ProcessEnv = process.env): PresetManager {
  return PresetManager.loadSync(defaultPresetFile(env));
}

/** 没有密钥就抛错：调用方负责转成可读提示，而不是发出一个注定 401 的请求 */
export function createLLM(config: CliConfig): LLMClient {
  if (!config.apiKey) {
    throw new MissingApiKeyError();
  }
  return new OpenAICompatibleClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
  });
}

export class MissingApiKeyError extends Error {
  constructor() {
    super("缺少模型密钥：请设置 DSH_API_KEY 或 DEEPSEEK_API_KEY");
    this.name = "MissingApiKeyError";
  }
}
