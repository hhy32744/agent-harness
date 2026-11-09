# 数据爬虫与清洗 · 课程项目

一个仓库装下《数据爬虫与清洗》的全部实验，最终目标是搭一个可用的**爬虫 agent**。

根目录是**实验三**产出的 DeepSeek Harness 最小内核——后续爬虫 agent 的底座；历史实验按 `labs/labN-*` 归档，不改动、只做参考。

## 一、实验索引

| 目录 | 实验 | 内容 | 状态 |
| --- | --- | --- | --- |
| `labs/lab2-ts-fetch/` | 实验二 | TypeScript 项目骨架 + Node 原生 fetch 抓取（真实网页 / JSON 接口 / 串行 vs 并发） | 已完成 |
| 仓库根目录 | 实验三 | DeepSeek Harness core 最小实现：消息协议、工具执行、会话、作用域、agent 主循环 | 已完成 |
| `labs/lab4-*` | 实验四 | 待补 | 进行中 |

## 二、仓库结构

```
.
├─ src/                    ← 实验三：harness core（当前主线）
│  ├─ core/
│  │  ├─ types.ts          消息协议（system / user / assistant / tool）
│  │  ├─ llm/              LLMClient 抽象 + OpenAI 兼容实现 + 离线脚本模型
│  │  ├─ tools/            ToolRegistry + fetch_url / extract_links / save_markdown
│  │  ├─ session/          消息流 + 事件日志 + fork
│  │  ├─ scope/            工具白名单、域名白名单、轮次/次数/超时预算
│  │  ├─ system-prompt/    按工具集与作用域动态拼提示词
│  │  ├─ agent-loop/       主循环（唯一控制流）
│  │  └─ agent/            装配
│  ├─ demo/mock-site.ts    本地演示站点
│  ├─ tests/core.test.ts   15 个用例
│  └─ cli.ts               端到端演示入口
├─ labs/
│  └─ lab2-ts-fetch/       实验二归档（独立 npm 工程）
├─ package.json
└─ tsconfig.json
```

## 三、实验三：Harness Core

不是框架、不引第三方运行时依赖：只用 TypeScript 类型 + Node 内置能力（`fetch` / `node:http` / `node:test`），把「模型 → 工具 → 模型」这条闭环和它的全部失败路径跑通。

### 一次 run 的数据流

```
user ─► session.append(user) ─► loop ─► llm.chat(messages, tools)
loop ─► assistant ─► 有 tool_calls ?
  有 → scope 准入 → 执行工具 → 回填 tool 消息 → 回到 loop
  无 → 返回最终答复 → session.end
```

### 四个刻意的设计决定

1. **错误也是消息**：未知工具、非法 JSON、超时、被 scope 拒绝，全部变成一条 `isError` 的 `tool` 消息，模型因此有机会自我修正，进程也不会因为一次失败退出。
2. **作用域前置**：`Scope` 在执行**之前**判定，被拒绝的调用不产生任何副作用；`fetch_url` 还会在重定向后二次校验最终主机，避免 302 绕过白名单。
3. **消息流与事件日志分离**：`messages` 严格遵循协议给模型看；`events` 记录轮次、耗时、拒绝原因给人复盘。
4. **超时必须靠 race**：只把 `AbortSignal` 传给工具是不够的——卡死的工具不会理会 abort，必须 `Promise.race` 把它变成真正的拒绝。

### 运行

```bash
npm install
npm run build        # tsc → dist/
npm test             # 15 个用例，覆盖 loop 的全部退出路径
npm run demo         # 离线：脚本模型 + 本地 mock 站点，完整跑一遍闭环
npm run demo:live    # 真实模型：需要 DEEPSEEK_API_KEY（可选 DEEPSEEK_MODEL）
```

`npm run demo` 的实际输出（节选）：

```
[    3ms] t1 tool.call  fetch_url {"url":"http://127.0.0.1:49544"}
[   42ms] t1 tool.done  fetch_url ok 459 chars
[   42ms] t2 tool.done  fetch_url ERROR 42 chars      ← 白名单外，未出网
[   43ms] t3 tool.done  extract_links ok 279 chars
[   48ms] t4 tool.done  fetch_url ok 369 chars
[   52ms] t5 tool.done  save_markdown ok 106 chars
[   52ms] t6 session  end     status=completed
```

### 换成自己的 agent

```ts
import { runAgent, Scope, webTools, OpenAICompatibleClient } from "./src/core";

const { result, session } = await runAgent("抓取 example.com 首页并总结", {
  role: "网页信息抽取助手",
  llm: new OpenAICompatibleClient({ apiKey: process.env.DEEPSEEK_API_KEY! }),
  tools: webTools,
  scope: Scope.crawler(["example.com"]),
});

console.log(result.status, result.turns, result.text);
// 消息流和事件都在 session 上：session.messages / session.events
```

`agent` 这一层只有一个函数、一个 `for` 都没有：建工具表 → 建会话 → 塞系统提示词 → 调 `runAgentLoop`。
要控制会话生命周期（续跑、分支）就不用 `runAgent`，直接调底层的 `runAgentLoop`，它本来就接受一个现成的 `Session`。
加能力就加 `ToolDefinition`，收边界就改 `Scope`，都不用动 `agent-loop`。

## 四、实验二：ts-fetch-lab（归档）

独立的 npm 工程，进入目录自行安装后运行，不影响根目录：

```bash
cd labs/lab2-ts-fetch
npm install
npm run build && npm start
```

它验证了三件事：Node 18+ 内置 fetch 的请求生命周期（Promise 兑现只代表响应头到达）、4xx/5xx 不会 reject、以及串行 `for + await` 与 `Promise.all` 的耗时差异（1811ms vs 608ms，约 2.98×）。

## 五、提交约定

- **一个主题一个 commit**，message 用 `feat:` / `fix:` / `docs:` / `chore:` / `refactor:` 前缀，写清"改了什么、为什么"。
- 新实验放 `labs/labN-<主题>/`，不要动根目录的主线代码；主线演进留在 `src/`。
- 不提交 `node_modules/`、`dist/`、`out/`、`.env`——已在 `.gitignore` 中；API key 只从环境变量读。

## 六、环境

- Node.js ≥ 18（内置 fetch），实测 v22.22.2
- TypeScript 5.6（根目录 devDependency，`npm run build` 用）
- 真实模型：DeepSeek `deepseek-chat`（OpenAI 兼容协议），需 `DEEPSEEK_API_KEY`
