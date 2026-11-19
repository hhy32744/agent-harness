/** 预设插件管理：公开 API 的唯一出口 */
export { PresetManager, defaultPresetFile } from "./manager";
export type { ResolveOptions } from "./manager";
export { BUILTIN_PRESETS, cloneBuiltins } from "./builtins";
export { applyToolPolicy, makeId, normalizePolicy } from "./types";
export type {
  Preset,
  PresetFile,
  PresetManifestItem,
  ResolvedPreset,
  ToolPolicy,
  ToolPolicyMode,
} from "./types";
