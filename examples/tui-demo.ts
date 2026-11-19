/**
 * 端到端演示：真实模型 + 真实 web_search + TUI 界面。
 *
 * 从桌面 .env 运行时读取密钥（不写进仓库），用脚本化 IO 喂一句话，
 * 让 TUI 跑一轮"发起 web-search 工具 → 拿到结果 → 作答"的完整流程，
 * 把带时间线的终端输出打印出来（可重定向到文件作为实验证据）。
 *
 * 运行：
 *   npm run demo:tui
 *   npm run demo:tui > out/tui-transcript.txt
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { OpenAICompatibleClient } from "../src/llm/openai-client";
import { PresetManager, defaultPresetFile } from "../src/preset";
import { Scope } from "../src/scope";
import { createToolset } from "../src/tools/toolset";
import { runTui, type TuiIO } from "../src/tui";

function loadEnvKey(): string | undefined {
  const candidates = [
    process.env.DSH_API_KEY,
    process.env.DEEPSEEK_API_KEY,
    process.env.DASHSCOPE_API_KEY,
  ].filter(Boolean) as string[];
  if (candidates.length) return candidates[0];

  // 兜底：从桌面 .env 读（仅在本地演示用；永远不写进仓库）
  const desktop = join(homedir(), "Desktop", ".env");
  try {
    const text = readFileSync(desktop, "utf8");
    const m = text.match(/^DASHSCOPE_API_KEY\s*=\s*"?([^"\r\n]+)"?/m);
    return m?.[1]?.trim();
  } catch {
    return undefined;
  }
}

function scriptedIO(inputs: string[]): { io: TuiIO; lines: string[] } {
  let i = 0;
  const lines: string[] = [];
  return {
    lines,
    io: {
      async ask(): Promise<string | null> {
        return inputs[i++] ?? null;
      },
      print(line = ""): void {
        const text = String(line).replace(/\x1b\[[0-9;]*m/g, ""); // 去色，便于存档
        lines.push(text);
        process.stdout.write(`${text}\n`);
      },
    },
  };
}

async function main(): Promise<void> {
  const key = loadEnvKey();
  if (!key) {
    console.error("未找到模型密钥：设置 DSH_API_KEY / DASHSCOPE_API_KEY，或确保桌面 .env 存在。");
    process.exit(1);
  }

  // 只设 DashScope key 时沿用兼容端点 + 便宜模型
  const useDash = !process.env.DSH_API_KEY && !process.env.DEEPSEEK_API_KEY;
  const llm = new OpenAICompatibleClient({
    apiKey: key,
    baseUrl: useDash ? "https://dashscope.aliyuncs.com/compatible-mode/v1" : "https://api.deepseek.com",
    model: process.env.DSH_MODEL ?? (useDash ? "qwen3.7-flash" : "deepseek-chat"),
  });

  // 问题写在源码里，避免 Windows 下 npm 透传中文参数时的转义噪声
  const question =
    process.argv[2] && !process.argv[2].includes("^")
      ? process.argv[2]
      : "用 web_search 查一下 Python 的 requests 库是做什么的，然后一句话回答";
  const { io } = scriptedIO([question, "/exit"]);
  const manager = PresetManager.loadSync(defaultPresetFile(process.env));

  await runTui({
    llm,
    tools: createToolset(),
    scope: new Scope({ maxTurns: 10, maxToolCalls: 12 }),
    role: "网页检索与信息抽取助手。最多搜索两次就必须基于已拿到的结果作答，不要无限重试。",
    presetManager: manager,
    name: "dsh",
    version: "0.1.0",
    io,
    color: false,
  });
}

main().catch((err) => {
  console.error("demo:tui 失败：", err);
  process.exit(1);
});
