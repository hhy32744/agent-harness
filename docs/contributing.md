# 开发与提交约定

## 目录规则

| 内容 | 放在哪 | 说明 |
| --- | --- | --- |
| 内核 | `src/` | 唯一公共 API 来源，不依赖 `examples/` 和 `tests/` |
| 可运行示例 | `examples/` | 演示怎么组装，或做离线自检，不写业务逻辑 |
| 测试 | `tests/` | 只从 `../src` import，不碰内核内部文件 |
| 环境脚本 | `scripts/` | 装环境、自检一类的辅助脚本 |
| 设计文档 | `docs/` | README 保持精简，细节写进这里 |
| 编译产物 | `build/` | `tsc` 输出，已忽略 |
| 运行产物 | `out/` | `save_markdown` 写入目录，已忽略 |

**新增能力一律先进 `src/`**：加一个 `ToolDefinition`、调 `ScopePolicy`、或实现 `LLMClient`；`agent-loop` 是唯一控制流，尽量不动。演示写进 `examples/`，不要另起独立 npm 工程。工作区同级的 `deliverables/` 放报告类交付物，不纳入版本控制。

## commit 规范

- **一个主题一个 commit**，message 用前缀写清「改了什么、为什么」：
  `feat:` / `fix:` / `docs:` / `chore:` / `refactor:` / `test:`
- 提交前至少跑一次 `npm run typecheck && npm test`。
- 不要把 API key 写进代码或文档，只从环境变量读。

## 环境变量

| 变量 | 用途 | 是否必需 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | 真实模型调用 | 仅 `npm run demo:live` 需要 |
| `DEEPSEEK_MODEL` | 覆盖默认模型 `deepseek-chat` | 可选 |
| `DEEPSEEK_BASE_URL` | 覆盖 OpenAI 兼容端点 | 可选 |

`npm run demo` 与 `npm run demo:fetch` 都是离线的，**不需要任何 key，也不发外网请求**。

## 不提交什么

`.gitignore` 已覆盖：`node_modules/`、`build/`、`out/`、`coverage/`、`*.tsbuildinfo`、`*.log`、`.env*`、`*.local`、编辑器与系统临时文件。

## 结构演进（2026-11-12）

为了让仓库始终只描述**一个最终项目**，做过三次收敛：

| 变化 | 结果 |
| --- | --- |
| 演示与测试从源码里分出 | `src/cli.ts → examples/cli.ts`、`src/demo/mock-site.ts → examples/mock-site.ts`、`src/tests/core.test.ts → tests/core.test.ts`；编译输出改到 `build/` |
| 去掉冗余的内核嵌套 | `src/core/* → src/*`，公共出口从 `./src/core` 变成 `./src`，`package.json` 的 `main` / `types` 同步更新 |
| 早期原型并入主线 | 独立的 fetch 工程改写为 `examples/fetch-basics.ts` + `docs/fetch-baseline.md`；部署脚本改写为 `scripts/setup.sh`；重复的工程副本、归档目录与中间产物清理掉 |

被移除的归档内容仍可从 git 历史找回，当前工作树不再保留第二套工程。

## 常用检查

```bash
npm run typecheck   # 只做类型检查，不产出文件
npm run build       # tsc → build/
npm ci              # 全新克隆后第一次安装（严格按锁文件）
npm test            # 编译 + 19 个用例
npm run demo        # 离线完整闭环
npm run demo:fetch  # 底层抓取能力自检
npm run verify      # 类型检查 + 测试
```

## 回归防线

[CI](.github/workflows/ci.yml) 在 Ubuntu / Windows / macOS × Node 18 / 20 / 22 上跑 `npm ci → typecheck → test → demo → demo:fetch`。改内核或示例时留意这几个已经踩过的坑：

- **本地站点的生命周期**：`startMockSite()` 之后必须用 `try/finally` 关掉，且 `close()` 要先 `closeAllConnections()`，否则异常路径或 keep-alive 连接会让进程挂住不退出（曾导致 `demo:live` 缺 key 时卡死）。
- **环境变量提前校验**：`demo:live` 的 `DEEPSEEK_API_KEY` 要在启动站点之前检查。
- **路径用 `node:path` 拼**：不要手动写 `${cwd}/out/...`，Windows 上容易得到混合分隔符。
- **shell 脚本保持 LF**：`.gitattributes` 已固定 `*.sh text eol=lf`。
- **测试不要依赖外网**：真实模型适配器用 `fetchImpl` 注入，脚本模型用 `ScriptedLLM`。
