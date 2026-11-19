# 命令行：`dsh`

> 内核是库，`dsh` 是它的执行入口。本文讲各条命令各自解决什么问题、参数怎么传、以及几个"为什么这样设计"的取舍。
> 只想跑起来，看 [README 快速开始](../README.md#快速开始)。

## 1. 命令一览

```bash
dsh                                    # 交互式聊天（多轮，同一会话保留上下文）
dsh tui                                # 终端界面：banner / 工具时间线（含耗时）/ 状态栏 / 会话落盘
dsh preset [list|use <id>|on <id>|off <id>|export|import <file>]  # 管理智能体预设
dsh prompt "抓取 example.com 首页并总结"  # 非交互任务，跑完打印结果
dsh read https://example.com/           # 直接读一个网页（不调模型，不需要 key）
dsh doctor                             # 环境与配置检查
dsh remote 4090 --prompt "查看 GPU 状态"  # 在远端机器上跑同一条 prompt，结果带回来
```

安装（可选，装完就能在任意目录调用 `dsh`）：

```bash
npm install && npm run build && npm link     # 或 npm install -g .
```

不装也能用：`npm run dsh -- doctor` 等价于 `dsh doctor`。

## 2. `dsh`：交互式聊天

```
$ dsh
dsh 0.1.0 | model=deepseek-chat | endpoint=https://api.deepseek.com | 主机=未限制 | 工具=4
= 会话启动 agent=dsh llm=openai-compatible:deepseek-chat tools=4

输入任务开始对话；/help 查看命令，/exit 退出。

dsh> 搜一下 4090 的显存规格
· 第1轮助手：（发起 1 个工具调用）
  -> web_search {"query":"4090 显存 规格","limit":5}
  <- web_search ok（1234 字）
· 第2轮助手：4090 是 24GB GDDR6X...
-- completed | 2 轮 | 1 次工具 | 1832ms token=2415
```

**关键设计：一次 `dsh` 进程只创建一个 `Session`，每行输入只是往里追加一条 `user` 消息再跑一次 loop。** 所以"接着上一轮追问"天然成立——`messages` 本身就是记忆，不需要另做记忆模块。`/reset` 的实现也就只是换一个 `Session`。

| 命令 | 作用 |
| --- | --- |
| `/help` | 列出可用命令 |
| `/reset` | 清空上下文，开新会话 |
| `/tools` | 当前暴露给模型的工具 |
| `/scope` | 主机白名单、工具白名单、轮次与次数预算 |
| `/events` | 本次会话的事件类型统计（排查"它到底干了什么"用） |
| `/exit` | 退出（`/quit`、`/q` 同义） |

Ctrl+D（EOF）同样退出。任务跑到一半出错的，只影响那一轮：错误以 `x 本轮失败：…` 打印，会话继续可用。

## 3. `dsh read`：不经过模型读一个网页

```bash
dsh read https://example.com/                 # 打印标题 + 正文
dsh read https://example.com/ --raw           # 原始 HTML，不做正文提取
dsh read https://example.com/ --full --max-bytes 65536
dsh read https://example.com/ --json          # 机器可读，字段与下面 ReadResult 一致
```

输出是这样的：

```
https://example.com/  →  200 text/html; charset=utf-8 | 577 B · 717ms
标题：Example Domain

────────────────────────────────────────────────────────────

This domain is for use in documentation examples without needing permission.
```

**为什么单独有这么一条命令。** agent 读网页要过大模型，没配 key 就什么都演示不了；但"能读网页"是内核能力，跟有没有 key 无关。所以 `read` 不另写一份抓取实现，而是走 `ToolRegistry.invoke` 调用**同一个** `fetch_url` —— 作用域校验、超时收敛、错误包装的行为与 agent 里完全一致。换句话说：`dsh read` 能看到什么，agent 就能看到什么。

| 参数 | 说明 |
| --- | --- |
| `--raw` | 输出原始 HTML，不做正文提取 |
| `--full` | 不截断正文（默认只显示前 4000 字符） |
| `--max-bytes <n>` | 最多读多少字节，默认 262144，硬上限 524288 |
| `--allow-host <hosts>` | 与 agent 同一套主机白名单；不在名单内直接拒绝 |

正文提取（`htmlToText`）刻意不引第三方解析库，只做三件事：丢掉 `script` / `style` / 注释、块级标签断行、解 HTML 实体。精确抽取结构化字段交给模型，命令行只负责"把网页变成人能读的文本"。这个取舍换来的是**零依赖 + 可单测**：`tests/cli.test.ts` 里既有纯字符串用例，也有一条起真实 HTTP 服务、走真实 socket 的用例。

退出码：2xx → 0；非 2xx、被白名单拒绝、网络错误 → 1；参数用法错误 → 2。

## 4. `dsh prompt`：一次性任务

```bash
dsh prompt "搜索 agent 框架的最新进展，挑 3 条总结" --max-turns 6
dsh prompt "把 example.com 的入口链接抓下来" --allow-host example.com --json
```

- 一次任务一个 `Session`，跑完就退出，适合放进脚本 / CI / crontab。
- `--json` 输出稳定结构（`status / text / turns / toolCalls / usage / elapsedMs / sessionId / error`），便于上层解析。
- 退出码：`completed` → 0；`max_turns` / `tool_budget` / `error` → 1；用法错误或缺少密钥 → 2。

## 5. `dsh doctor`：先把环境说清楚

```
[ok  ] Node 版本：v22.22.2（要求 >= 18）
[warn] 模型密钥：未设置 DSH_API_KEY / DEEPSEEK_API_KEY —— 交互与 prompt 子命令需要它
[warn] 模型端点：https://api.deepseek.com/models 未探测（缺少密钥）
[ok  ] 输出目录：/path/to/out 可写（save_markdown 落盘位置）
[ok  ] 工具集：4 个：web_search, fetch_url, extract_links, save_markdown
[ok  ] 搜索端点：HTTP 200（https://www.bing.com/search）
[ok  ] SSH 主机：6 个：node03, 192.168.200.130, ...
[ok  ] 运行参数：model=deepseek-chat 主机白名单=未限制 轮次<=8 工具<=16

结果：6 通过 / 2 警告 / 0 失败
```

检查项与判据：

| 检查 | 判据 | 失败意味着 |
| --- | --- | --- |
| Node 版本 | 主版本 ≥ 18 | 没有内置 `fetch`，跑不起来 |
| 模型密钥 | `DSH_API_KEY` / `DEEPSEEK_API_KEY` 任一存在 | 只 warn：离线演示仍可用 |
| 模型端点 | 带密钥 `GET {baseUrl}/models` | 401/403 判 fail（密钥无效），网络不通只 warn |
| 输出目录 | 在 `out/` 写一个临时文件再删掉 | `save_markdown` 会失败 |
| 工具集 | 按名字装载工具 | 名字拼错（`--tools`）在这里就暴露 |
| 搜索端点 | `GET {endpoint}?q=test` | 只 warn：`web_search` 不可用，其余工具不受影响 |
| SSH 主机 | 解析 `~/.ssh/config` 的 `Host` | 只 warn：`remote` 子命令无处可连 |
| 运行参数 | 汇总实际生效的 model / 白名单 / 预算 | 对照"我以为配了"和"实际生效" |

**为什么缺密钥只是 warn 而不是 fail**：CI 里没有密钥，`dsh doctor` 要能当冒烟检查跑。要把它当门禁时加 `--strict`，警告也会返回非 0。

## 6. `dsh remote`：借另一台机器跑

```bash
dsh remote 4090 --prompt "查看 GPU 占用并汇总"     # 远端跑一次，输出流回本地
dsh remote node03                                  # 远端开交互会话（ssh -t）
```

实现就是一条 ssh，不做常驻服务、不做端口转发：

```
ssh -- <host> 'dsh prompt ... --allow-host ...'
```

- 主机名直接用 `~/.ssh/config` 里的 `Host` 别名，认证、跳板机、密钥都由 ssh 自己管。
- 远端只需要装好 `dsh` 且配好模型密钥；命令名可用 `DSH_REMOTE_BIN` 覆盖。
- 任务文本经过单引号转义后作为**参数**传递，不会被远端 shell 拆成命令（`dsh prompt "a; rm -rf /"` 中的分号不会被解释）。
- 本地参数（`--allow-host` / `--model` / `--max-turns` / `--json`）会原样转发给远端。

> 之所以不用"远端 agent 服务 + HTTP 回传"：那需要一个常驻进程、一套鉴权和版本兼容；而 `ssh host cmd` 已经解决了认证与传输，运维成本最低。

## 8. 参数表

| 参数 | 适用 | 说明 |
| --- | --- | --- |
| `--model <name>` | 全部 | 默认 `DSH_MODEL` → `DEEPSEEK_MODEL` → `deepseek-chat` |
| `--base-url <url>` | 全部 | OpenAI 兼容端点，默认 `https://api.deepseek.com` |
| `--allow-host <hosts>` | 全部 | 抓取主机白名单，逗号分隔，支持 `*.example.com`；也接受整条 URL（自动取主机名） |
| `--tools <names>` | 全部 | 默认 `web_search,fetch_url,extract_links,save_markdown` |
| `--max-turns <n>` | 全部 | agent 最大轮次，默认 8 |
| `--max-tool-calls <n>` | 全部 | 单次任务工具调用上限，默认 16 |
| `--json` | prompt / read / doctor | 机器可读输出 |
| `--quiet` | 全部 | 不打印过程事件，只给结果 |
| `--strict` | doctor | 警告也返回非 0 |
| `--raw` | read | 输出原始 HTML |
| `--full` | read | 不截断正文 |
| `--max-bytes <n>` | read | 读取字节上限，默认 262144 |

## 9. 环境变量

| 变量 | 用途 | 默认 |
| --- | --- | --- |
| `DSH_API_KEY` / `DEEPSEEK_API_KEY` / `DASHSCOPE_API_KEY` | 模型密钥，按此顺序取第一个 | 无，`prompt`/`chat` 必需 |
| `DSH_BASE_URL` / `DEEPSEEK_BASE_URL` | OpenAI 兼容端点 | `https://api.deepseek.com` |
| `DSH_MODEL` / `DEEPSEEK_MODEL` | 模型名 | `deepseek-chat` |
| `DSH_SEARCH_ENDPOINT` | `web_search` 的搜索页地址 | `https://www.bing.com/search` |
| `DSH_REMOTE_BIN` | `remote` 在远端执行的命令 | `dsh` |

优先级：**命令行 > `DSH_*` > `DEEPSEEK_*` > 内置默认**。`DASHSCOPE_API_KEY` 作为密钥兜底参与第一项，且当它是唯一密钥时，端点与默认模型自动切到阿里云：

```bash
export DASHSCOPE_API_KEY=sk-...     # 只此一个变量即可
dsh doctor                         # 端点自动为 dashscope 兼容地址，模型 qwen-plus
dsh prompt "读出 example.com 首页标题" --allow-host example.com
```

这样做是为了兼容两种常见情况：只拿得到阿里云 key 的人不用背端点和模型名；已经有 DeepSeek key 的人行为完全不变 —— 只要存在 `DSH_*` 或 `DEEPSEEK_*` 密钥，就仍走原来的默认端点与模型。显式传 `--model` / `--base-url` 或 `DSH_MODEL` / `DSH_BASE_URL` 永远最高优先。

默认值只写在 `src/cli/config.ts` 一处，避免"doctor 检查的"和"实际跑的"不一致。

## 10. `web_search` 为什么默认用必应

| 端点 | 结构 | 可达性 |
| --- | --- | --- |
| `https://www.bing.com/search` | `<li class="b_algo"><h2><a>` + `<p class="b_lineclamp">` | 国内可直连（会 302 到 cn.bing.com） |
| `https://html.duckduckgo.com/html/` | `a.result__a` + `a.result__snippet` | 部分网络环境不可达 |

解析器按页面特征**自动识别**（见 `parseSearchHtml`），所以换端点通常不用改代码：

```bash
DSH_SEARCH_ENDPOINT="https://html.duckduckgo.com/html/" dsh prompt "搜点什么"
```

必应的部分结果走 `/ck/a?u=a1<base64url>` 跳转，工具会把它还原成真实地址；还原不出来的直接丢弃，绝不让模型拿着必应内部链接去抓。

与作用域的关系需要说清楚：**搜索请求发往固定端点，URL 不由模型控制，因此不走抓取主机白名单**；但 `web_search` 本身仍受工具白名单约束（不想要联网搜索就从 `--tools` 里去掉它）；搜索结果里的页面再用 `fetch_url` 抓时，照常受 `--allow-host` 限制。

## 11. 省钱指南（学生党）

模型调用按 Token 计费，输入和输出单价不同。几条实测有效的做法：

**1. 用免费额度，并开「用完即停」。** 阿里云百炼新用户开通即赠 **每个模型各 100 万 Token（输入/输出分别计），有效期 90 天**，无需手动领取。在 [百炼控制台](https://bailian.console.aliyun.com/) 可以查剩余额度，并打开「免费额度用完即停」开关 —— 这样即使额度耗尽也不会产生欠费。以本项目的用量，一次「读网页 + 回答」大约 2000–3000 Token，100 万 Token 够跑几百次。

**2. 默认就用便宜模型。** 只设 `DASHSCOPE_API_KEY` 时，本项目默认模型是 `qwen3.7-flash`：实测能正确发起 `tool_calls`，完整网页读取闭环跑通，而价格比 `qwen-plus` 低一个数量级。需要更强的推理时再临时切：

```bash
DSH_MODEL=qwen-plus dsh prompt "需要多步推理的复杂任务..."
DSH_MODEL=qwen4-max dsh prompt "..."      # 最强，但更贵且带思维链
```

**3. 每次跑完看 Token 数。** `dsh prompt` 和交互模式都会打印本次用量，输入/输出分列：

```
-- completed | 2 轮 | 1 次工具 | 3195ms token=2632（输入 2576 / 输出 56）
```

`--json` 输出里是 `usage.promptTokens` / `usage.completionTokens` / `usage.totalTokens` 三个字段，可以自己记账。项目不硬编码价格 —— 各渠道报价随时变，对着控制台账单算才准。

**4. 少喂废话，少转轮次。** 成本 ≈ 每轮把全部历史消息重发一遍，所以：

```bash
dsh prompt "任务" --max-turns 4        # 默认 8，能少则少
dsh prompt "任务" --tools fetch_url    # 只留需要的工具，缩小 system prompt
dsh read <url> --max-bytes 4096        # 直读网页不过模型，完全不花钱
```

其中 `dsh read` 是纯内核能力，**一次模型都不调用**，验证网络读取时用它是零成本的。

> 价格参考（2026-11，公开资料，以官方账单为准）：Flash 系列约 ¥0.8/百万输入、¥2/百万输出，Plus 系列约 ¥0.96–4.8/百万输入、¥2.4–4.8/百万输出；Batch 调用通常半价。免费额度本身不区分模型档位。

## 11b. `dsh tui`：终端交互界面

`dsh tui` 与 `dsh` 共用同一套内核（同一 `Session` / 工具集 / 作用域），只是换了一层呈现：

- 顶部 ASCII banner + 模型 / 预设 / 版本 + `/help 帮助 · Esc 取消 · <Ctrl+C> 强制退出`；
- 用户轮以 `▶` 标记；每次工具调用打印 `● web-search {...}`，结果回来补一行 `└ ok 388 ms`——耗时取事件时间戳之差，真实墙钟；
- 一轮结束打印 `本轮完成` + 状态栏（`模型 · 缓存 · 待处理 N · token 数`）；
- 会话每轮以 JSONL 落盘到 `$DSH_HOME/sessions/<sessionId>/session.jsonl`（默认 `~/.dsh/sessions`），可用于复盘评分。

内置斜杠命令：`/help` `/preset [id]` `/tools` `/scope` `/reset` `/exit`。在真实 TTY 里按 `Esc` 取消当前轮（通过 `AbortSignal`），`<Ctrl+C>` 退出。非 TTY（管道 / 测试）自动关闭 Esc 监听。

```bash
npm run dsh -- tui                       # 交互式
npm run demo:tui                         # 脚本化输入的端到端演示（真实模型 + 真实 web_search）
npm run demo:tui > out/tui-transcript.txt  # 存档终端输出作为执行证据
```

## 11c. `dsh preset`：智能体预设管理

一个**预设**把四样东西打成一个可复用配置包：人设 `role`、工具策略（全量 / 白名单 / 排除名单）、作用域覆盖（轮次 / 工具次数 / 输出上限）、元信息（id / 名称 / 描述 / 启停 / 顺序 / 额外规则）。设计参照 DSH（DeepSeek Harness）的 preset 机制，三层生效：给模型的工具清单（可见性）→ `Scope.allowedTools`（调用守卫）→ system prompt（人设注入）。

```bash
dsh preset                       # 列出全部预设与当前激活项
dsh preset use builtin:search-only   # 激活：工具收窄为 web_search，预算 4 轮
dsh preset on builtin:web        # 启用
dsh preset off builtin:web       # 禁用（禁用后自动回退到第一个启用项）
dsh preset export                # 导出元信息清单 JSON（不含提示词与名单）
dsh preset import list.json      # 导入清单，只更新本地已有 id
```

内置三个预设：`builtin:web`（默认四件套）、`builtin:search-only`（最省额度）、`builtin:readonly-crawl`（已知 URL 精读）。也可用 `--preset <id>` 或 `DSH_PRESET` 单次指定；命令行显式参数（`--tools` / `--role` / `--max-turns`）始终高于预设。

配置文件：`$DSH_HOME/presets.json`（默认 `~/.dsh/presets.json`），原子写（临时文件 + rename）。文件缺失或损坏都会降级到内置预设，不阻断启动。内置预设不可删除 / 覆盖，只能启停；自定义预设可新增（`PresetManager.upsert`）、复制、两步确认删除。导入 / 导出只含元信息，避免把提示词与名单写进分享文件。

## 11d. web_search 的后端切换

默认零依赖抓必应 HTML；两种切换方式：

- `DSH_SEARCH_ENDPOINT`：换 HTML 搜索引擎（必应 / DuckDuckGo / SearXNG），解析器按页面特征自动识别；
- `DSH_SEARCH_PROVIDER=tavily` + `DSH_TAVILY_KEY`：改用 Tavily JSON API（`TAVILY_ENDPOINT` 固定），返回更稳但需 key 与额度。

进程内带 10 分钟搜索缓存：同一 query 秒回，TUI 状态栏会显示缓存命中，既省钱又能看出重复调用。

## 12. 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功（`doctor` 无 fail；`--strict` 时无 warn；`read` 拿到 2xx） |
| 1 | 任务未完成（`max_turns` / `tool_budget` / `error`）；doctor 有 fail；`read` 非 2xx 或被白名单拒绝 |
| 2 | 用法错误：未知子命令、缺任务文本、缺 URL、未知参数、缺少模型密钥 |

## 12. 已知限制

- 交互模式没有流式输出：模型整段返回后再打印（`OpenAICompatibleClient` 目前是 `stream: false`）。
- `dsh` 交互式聊天退出后上下文即丢弃；需要落盘复盘请用 `dsh tui`（每轮写 JSONL 到 `~/.dsh/sessions/`），或自己用 `runAgentLoop` + 现成 `Session`。
- `remote` 依赖远端已装 `dsh`；没有远端安装时，`dsh remote` 会在 ssh 之后报"command not found"。
- 没有多行输入与文件附件；需要长文本时用 `dsh prompt "$(cat task.txt)"` 这类 shell 组合。
