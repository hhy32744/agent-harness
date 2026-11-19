/**
 * `dsh preset` 子命令：列出 / 激活 / 启停 / 导出 / 导入预设。
 * 只做配置管理，不装配 LLM；导出的是元信息清单，避免把提示词/名单写进分享文件。
 */
import { readFile } from "node:fs/promises";
import type { PresetAction } from "./args";
import type { CliIO } from "./index";
import type { PresetManifestItem } from "../preset";
import { defaultPresetFile } from "../preset";
import { loadPresetManager } from "./config";

export async function runPresetCommand(
  operation: PresetAction,
  env: NodeJS.ProcessEnv,
  io: CliIO,
  json = false,
): Promise<number> {
  const manager = loadPresetManager(env);
  const file = defaultPresetFile(env);

  switch (operation.action) {
    case "list": {
      if (json) {
        io.out(JSON.stringify(manager.manifest(), null, 2));
      } else {
        const rows = manager.list().map((p) => {
          const mark = p.id === manager.active?.id ? "*" : " ";
          const on = p.enabled ? "on " : "off";
          const tag = p.builtin ? "[内置]" : "[自定义]";
          return `${mark} ${p.id.padEnd(24)} ${on} ${tag} ${p.name} — ${p.description}`;
        });
        io.out(`预设（当前激活：${manager.active?.name ?? "无"}）`);
        io.out(rows.join("\n"));
        io.out("提示：dsh preset use <id> 激活；on/off 启停；export/import 分享元信息。");
      }
      return 0;
    }
    case "use":
      try {
        manager.use(operation.id);
        await manager.save(file);
        io.out(`已激活预设 ${manager.active?.name} (${operation.id})`);
        return 0;
      } catch (err) {
        io.err(`dsh: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
      }
    case "on":
    case "off":
      try {
        manager.setEnabled(operation.id, operation.action === "on");
        await manager.save(file);
        io.out(`预设 ${operation.id} 已${operation.action === "on" ? "启用" : "禁用"}`);
        return 0;
      } catch (err) {
        io.err(`dsh: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
      }
    case "export": {
      io.out(JSON.stringify(manager.manifest(), null, 2));
      return 0;
    }
    case "import": {
      try {
        const raw = await readFile(operation.file, "utf8");
        const items = JSON.parse(raw) as PresetManifestItem[];
        if (!Array.isArray(items)) throw new Error("导入文件应为 JSON 数组");
        const { updated, skipped } = manager.importManifest(items);
        await manager.save(file);
        io.out(`导入完成：更新 ${updated} 项，跳过 ${skipped} 项（本地不存在的 id）`);
        return 0;
      } catch (err) {
        io.err(`dsh: 导入失败：${err instanceof Error ? err.message : String(err)}`);
        return 1;
      }
    }
  }
}
