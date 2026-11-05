# agent-harness

DeepSeek Harness 的**最小内核**实现，用于后续搭爬虫类 agent。

不是框架、不引第三方运行时依赖：只用 TypeScript 类型 + Node 内置能力（`fetch` / `node:http` / `node:test`），
把「模型 → 工具 → 模型」这条闭环和它的全部失败路径跑通。

## 一、core 的五个零件 + 一个循环

```
src/core/
├─ types.ts            消息协议：system / user / assistant / tool
├─ llm/
│  ├─ types.ts         LLMClient 抽象（唯一的模型入口）
│  ├─ openai-client.ts OpenAI 兼容实现（DeepSeek / vLLM / Ollama 通用）
│  └─ scripted-client.ts  脚本模型，离线复现 + 单元测试
├─ tools/
│  ├─ types.ts         ToolDefinition / ToolContext / ToolResult
│  ├─ registry.ts      注册、作用域准入、超时、错误收敛、输出截断
│  └─ builtin/web.ts   fetch_url / extract_links / save_markdown
├─ session/index.ts    消息流 + 事件日志 + fork
├─ scope/index.ts      工具白名单、域名白名单、轮次/次数/超时预算
├─ system-prompt/      按当前工具集与作用域动态拼提示词
├─ agent-loop/         主循环（唯一控制流）
└─ agent/              装配：llm + tools + session + scope
```

数据流只有一条：

```
user → session → loop ──▶ llm.chat(messages, tools)
                    ▲              │
                    │        tool_calls?
                    │              │ yes
                    └── tool message ◀── registry.invoke (scope → 超时 → 执行 → 截断)
                                   │ no
                                   ▼
                              最终答复，循环结束
```

## 二、四个刻意的设计决定

1. **错误也是消息**：未知工具、非法 JSON、超时、被 scope 拒绝，全部变成一条 `isError` 的 `tool` 消息，
   而不是抛异常。模型因此有机会自我修正，进程也不会因为一次失败退出。
2. **作用域前置**：`Scope` 在执行**之前**判定，被拒绝的调用不会产生任何副作用（不会发一次请求）。
   `fetch_url` 还会在重定向后二次校验最终主机，避免 302 绕过白名单。
3. **消息流与事件日志分离**：`messages` 严格遵循协议给模型看；`events` 记录轮次、耗时、拒绝原因给人复盘。
4. **超时必须靠 race**：只把 `AbortSignal` 传给工具是不够的 —— 一个卡死的工具不会理会 abort。
   `registry.withTimeout` 用 `Promise.race` 把 abort 变成真正的拒绝。

## 三、运行

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

status      : completed
turns       : 6
tool calls  : 5 (errors: 1)
elapsed     : 52ms
```

产物：`out/crawl-report.md`。

## 四、换成自己的 agent

```ts
import { Agent, Scope, webTools, OpenAICompatibleClient } from "./core";

const agent = new Agent({
  name: "my-crawler",
  role: "网页信息抽取助手",
  llm: new OpenAICompatibleClient({ apiKey: process.env.DEEPSEEK_API_KEY! }),
  tools: webTools,
  scope: Scope.crawler(["example.com"]),
});

const { result, session } = await agent.run("抓取 example.com 首页并总结");
```

要加能力就加 `ToolDefinition`，要收边界就改 `Scope`，都不需要动 `agent-loop`。

## 五、明确没做的（留给后续实验）

- 流式输出 / 增量渲染
- 上下文压缩（长会话裁剪历史消息）
- 多 agent 编排与工具权限审批（human-in-the-loop）
- robots.txt 与限速、去重队列
- 持久化（会话落盘、断点续跑）
