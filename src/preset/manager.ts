/**
 * PresetManager：预设的注册、启停、解析与持久化。
 *
 * 关键约定：
 *   - 默认把内置预设装进内存，磁盘文件只作为"覆盖层"叠加，因此文件坏了也不影响开箱可用；
 *   - 写文件走"临时文件 + rename"原子替换，避免写一半崩掉留下半个 JSON；
 *   - 解析（resolve）只产出配置对象，不执行任何工具，便于离线测试。
 */
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { cloneBuiltins } from "./builtins";
import {
  applyToolPolicy,
  makeId,
  normalizePolicy,
  type Preset,
  type PresetFile,
  type PresetManifestItem,
  type ResolvedPreset,
} from "./types";

export interface ResolveOptions {
  /** 工具全集，用于白名单/排除名单过滤 */
  universe?: readonly string[];
  /** 显式指定 id；否则取 activeId */
  id?: string;
}

/** 默认预设文件路径：$DSH_HOME/presets.json，未设 DSH_HOME 则 ~/.dsh/presets.json */
export function defaultPresetFile(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DSH_HOME?.trim() || join(homedir(), ".dsh");
  return join(home, "presets.json");
}

export class PresetManager {
  private readonly presets = new Map<string, Preset>();
  private activeId: string | undefined;
  private filePath: string | undefined;

  constructor(presets: Preset[] = cloneBuiltins(), activeId?: string, filePath?: string) {
    for (const p of presets) this.presets.set(p.id, this.sanitize(p));
    this.activeId = activeId;
    this.filePath = filePath;
  }

  private sanitize(p: Preset): Preset {
    return {
      ...p,
      tools: normalizePolicy(p.tools),
      scope: { ...p.scope },
      extraRules: [...(p.extraRules ?? [])],
    };
  }

  /** 从磁盘加载：文件不存在返回纯内置；文件损坏抛可读错误，调用方决定降级 */
  static async load(filePath: string): Promise<PresetManager> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return new PresetManager(cloneBuiltins(), undefined, filePath);
      }
      throw err;
    }
    let data: PresetFile;
    try {
      data = JSON.parse(raw) as PresetFile;
    } catch {
      throw new Error(`预设文件不是合法 JSON：${filePath}`);
    }
    if (!data || !Array.isArray(data.presets)) {
      throw new Error(`预设文件结构不对（缺少 presets 数组）：${filePath}`);
    }
    // 磁盘里的同 id 覆盖内置，其余内置仍保留
    const merged = new Map(cloneBuiltins().map((p) => [p.id, p]));
    for (const p of data.presets) merged.set(p.id, p);
    return new PresetManager([...merged.values()], data.activeId, filePath);
  }

  /**
   * 同步加载：config 解析是同步的，不能 await。文件缺失返回内置默认；
   * 文件损坏则降级到内置（不打断启动），并通过 onWarning 回报。
   */
  static loadSync(filePath: string, onWarning?: (msg: string) => void): PresetManager {
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return new PresetManager(cloneBuiltins(), undefined, filePath);
      }
      onWarning?.(`读取预设文件失败，使用内置默认：${String(err)}`);
      return new PresetManager(cloneBuiltins(), undefined, filePath);
    }
    try {
      const data = JSON.parse(raw) as PresetFile;
      if (!data || !Array.isArray(data.presets)) throw new Error("缺少 presets 数组");
      const merged = new Map(cloneBuiltins().map((p) => [p.id, p]));
      for (const p of data.presets) merged.set(p.id, p);
      return new PresetManager([...merged.values()], data.activeId, filePath);
    } catch (err) {
      onWarning?.(`预设文件损坏，使用内置默认：${String(err)}`);
      return new PresetManager(cloneBuiltins(), undefined, filePath);
    }
  }

  /** 原子写：先写同目录临时文件，再 rename */
  async save(filePath = this.filePath): Promise<void> {
    if (!filePath) throw new Error("没有指定预设文件路径");
    await mkdir(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    const payload: PresetFile = {
      version: 1,
      activeId: this.activeId,
      presets: this.list(),
    };
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(tmp, filePath);
    this.filePath = filePath;
  }

  /** 按 order 再按 id 排序，稳定输出 */
  list(): Preset[] {
    return [...this.presets.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  }

  get(id: string): Preset | undefined {
    const p = this.presets.get(id);
    return p ? { ...p, tools: { ...p.tools, names: [...p.tools.names] }, scope: { ...p.scope }, extraRules: [...p.extraRules] } : undefined;
  }

  has(id: string): boolean {
    return this.presets.has(id);
  }

  get active(): Preset | undefined {
    if (this.activeId) {
      const p = this.presets.get(this.activeId);
      if (p?.enabled) return p;
    }
    // 未指定或指定项被禁用时，取排序后第一个启用的
    return this.list().find((p) => p.enabled);
  }

  use(id: string): void {
    const p = this.presets.get(id);
    if (!p) throw new Error(`未知预设 ${id}`);
    if (!p.enabled) throw new Error(`预设 ${id} 已禁用，无法激活`);
    this.activeId = id;
  }

  setEnabled(id: string, enabled: boolean): void {
    const p = this.presets.get(id);
    if (!p) throw new Error(`未知预设 ${id}`);
    p.enabled = enabled;
    if (!enabled && this.activeId === id) this.activeId = undefined;
  }

  /**
   * 新增或编辑。相同 id 覆盖；新建时若没给 id 就生成一个。
   * 返回最终落库的预设。
   */
  upsert(input: Omit<Preset, "id" | "builtin"> & { id?: string }): Preset {
    const id = input.id?.trim() || makeId(input.name);
    const existing = this.presets.get(id);
    if (existing?.builtin) throw new Error(`内置预设 ${id} 不可覆盖，请复制后再改`);
    const preset = this.sanitize({
      id,
      name: input.name,
      description: input.description,
      enabled: input.enabled,
      order: input.order,
      role: input.role,
      tools: input.tools,
      scope: input.scope,
      searchEndpoint: input.searchEndpoint,
      extraRules: input.extraRules,
    });
    this.presets.set(id, preset);
    return this.get(id)!;
  }

  /** 两步确认删除：confirm=true 才真删；内置预设一律拒绝 */
  remove(id: string, confirm = false): void {
    const p = this.presets.get(id);
    if (!p) throw new Error(`未知预设 ${id}`);
    if (p.builtin) throw new Error(`内置预设 ${id} 不可删除`);
    if (!confirm) throw new Error(`删除 ${id} 需要二次确认（confirm=true）`);
    this.presets.delete(id);
    if (this.activeId === id) this.activeId = undefined;
  }

  /** 复制一份，id 重新生成，名字加"副本" */
  duplicate(id: string): Preset {
    const src = this.get(id);
    if (!src) throw new Error(`未知预设 ${id}`);
    return this.upsert({
      name: `${src.name} 副本`,
      description: src.description,
      enabled: true,
      order: src.order + 1,
      role: src.role,
      tools: src.tools,
      scope: src.scope,
      searchEndpoint: src.searchEndpoint,
      extraRules: src.extraRules,
    });
  }

  /** 导出清单：只含元信息，不含提示词/名单明细 */
  manifest(): PresetManifestItem[] {
    return this.list().map(({ id, name, description, enabled, order }) => ({ id, name, description, enabled, order }));
  }

  /** 导入清单：只更新已有预设的元信息（启停/顺序/名字），不注入提示词或名单 */
  importManifest(items: readonly PresetManifestItem[]): { updated: number; skipped: number } {
    let updated = 0;
    let skipped = 0;
    for (const item of items) {
      const p = this.presets.get(item.id);
      if (!p) {
        skipped += 1;
        continue;
      }
      p.name = item.name;
      p.description = item.description;
      p.enabled = item.enabled;
      p.order = item.order;
      updated += 1;
    }
    return { updated, skipped };
  }

  /** 解析成可直接消费的配置；不传 id 则用 active */
  resolve(opts: ResolveOptions = {}): ResolvedPreset | undefined {
    const p = opts.id ? this.get(opts.id) : this.active;
    if (!p) return undefined;
    const universe = opts.universe ?? [];
    return {
      id: p.id,
      name: p.name,
      role: p.role || undefined,
      toolNames: applyToolPolicy(p.tools, universe),
      scope: { ...p.scope },
      searchEndpoint: p.searchEndpoint,
      extraRules: [...p.extraRules],
    };
  }
}
