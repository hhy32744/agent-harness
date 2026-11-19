/**
 * Preset（智能体预设）：把"人设 + 工具策略 + 运行边界 + 元信息"打成一个可复用、
 * 可开关、可导入导出的配置包。
 *
 * 设计参照 DSH（DeepSeek Harness）的 preset 机制，但这里只保留内核真正用得到、
 * 且能离线测试的部分：
 *   1) 一个预设 = persona（role）+ 工具策略（whitelist / exclude）+ scope 覆盖 + 元信息；
 *   2) 三层生效：可见性（给模型的工具清单）、调用守卫（Scope.allowedTools）、
 *      提示词组装（role / extraRules 进入 system prompt）；
 *   3) 管理动作：新增 / 编辑 / 删除（两步确认）/ 启停 / 复制 / 导出 / 导入；
 *   4) 持久化：临时文件 + rename 原子写，避免写一半损坏。
 *
 * 与 core 的关系：PresetManager 只产出"配置"，不碰 Session / Loop。真正执行仍在
 * ToolRegistry + Scope 里，所以预设无法绕过 scope 预算与工具白名单。
 */
import type { ScopePolicy } from "../scope";

/** 工具策略：全量 / 仅白名单 / 排除名单 */
export type ToolPolicyMode = "all" | "whitelist" | "exclude";

export interface ToolPolicy {
  mode: ToolPolicyMode;
  /** mode=whitelist 时是"允许的工具"；mode=exclude 时是"排除的工具"；all 时忽略 */
  names: string[];
}

export interface Preset {
  /** 稳定 id，例如 "builtin:crawler" / "custom-8f3a" */
  id: string;
  name: string;
  description: string;
  /** 启停：关闭的预设不参与 active 选择 */
  enabled: boolean;
  /** 排序：越小越靠前 */
  order: number;
  /** 人设；空串表示沿用调用方默认角色 */
  role: string;
  tools: ToolPolicy;
  /** 对该预设生效的 scope 覆盖，未出现的键沿用运行配置 */
  scope: Partial<ScopePolicy>;
  /** 覆盖搜索端点；不填则用 DSH_SEARCH_ENDPOINT / 默认必应 */
  searchEndpoint?: string;
  /** 追加到系统提示词的业务规则 */
  extraRules: string[];
  /** 内置预设不可删除，只能启停 */
  builtin?: boolean;
}

/** resolve 后的预设：直接可以喂给 config / system prompt */
export interface ResolvedPreset {
  id: string;
  name: string;
  role?: string;
  /** undefined 表示"不限制"（全量工具） */
  toolNames?: string[];
  scope: Partial<ScopePolicy>;
  searchEndpoint?: string;
  extraRules: string[];
}

/** 导出 / 导入的清单：只含元信息，不含提示词与名单明细，避免误泄配置 */
export interface PresetManifestItem {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  order: number;
}

export interface PresetFile {
  version: 1;
  /** 当前激活的预设 id；undefined 表示用内置默认 */
  activeId?: string;
  presets: Preset[];
}

export function makeId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `custom-${slug || "preset"}-${suffix}`;
}

export function normalizePolicy(policy: ToolPolicy): ToolPolicy {
  const names = [...new Set(policy.names.map((n) => n.trim()).filter(Boolean))];
  // 与 DSH 一致：选了白名单却一个都不勾，归一为全量，避免"启用了却什么都做不了"
  if (policy.mode === "whitelist" && names.length === 0) return { mode: "all", names: [] };
  return { mode: policy.mode, names };
}

/** 按策略算出实际可见的工具名；all 返回 undefined，交给上层用默认全集 */
export function applyToolPolicy(policy: ToolPolicy, universe: readonly string[]): string[] | undefined {
  const p = normalizePolicy(policy);
  if (p.mode === "all") return undefined;
  if (p.mode === "whitelist") return universe.filter((n) => p.names.includes(n));
  return universe.filter((n) => !p.names.includes(n));
}
