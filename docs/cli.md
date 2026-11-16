# 命令行：`dsh`

> 内核是库，`dsh` 是它的执行入口。本文讲五条命令各自解决什么问题、参数怎么传、以及几个"为什么这样设计"的取舍。
> 只想跑起来，看 [README 快速开始](../README.md#快速开始)。

## 1. 五条命令

```bash
dsh                                    # 交互式聊天（多轮，同一会话保留上下文）
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

## 7. 参数表

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

## 8. 环境变量

| 变量 | 用途 | 默认 |
| --- | --- | --- |
| `DSH_API_KEY` / `DEEPSEEK_API_KEY` | 模型密钥（前者优先） | 无，`prompt`/`chat` 必需 |
| `DSH_BASE_URL` / `DEEPSEEK_BASE_URL` | OpenAI 兼容端点 | `https://api.deepseek.com` |
| `DSH_MODEL` / `DEEPSEEK_MODEL` | 模型名 | `deepseek-chat` |
| `DSH_SEARCH_ENDPOINT` | `web_search` 的搜索页地址 | `https://www.bing.com/search` |
| `DSH_REMOTE_BIN` | `remote` 在远端执行的命令 | `dsh` |

优先级：**命令行 > `DSH_*` > `DEEPSEEK_*` > 内置默认**。默认值只写在 `src/cli/config.ts` 一处，避免"doctor 检查的"和"实际跑的"不一致。

## 9. `web_search` 为什么默认用必应

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

## 10. 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功（`doctor` 无 fail；`--strict` 时无 warn；`read` 拿到 2xx） |
| 1 | 任务未完成（`max_turns` / `tool_budget` / `error`）；doctor 有 fail；`read` 非 2xx 或被白名单拒绝 |
| 2 | 用法错误：未知子命令、缺任务文本、缺 URL、未知参数、缺少模型密钥 |

## 11. 已知限制

- 交互模式没有流式输出：模型整段返回后再打印（`OpenAICompatibleClient` 目前是 `stream: false`）。
- 会话不持久化：`dsh` 退出后上下文即丢弃；续跑要自己用 `runAgentLoop` + 现成 `Session`。
- `remote` 依赖远端已装 `dsh`；没有远端安装时，`dsh remote` 会在 ssh 之后报"command not found"。
- 没有多行输入与文件附件；需要长文本时用 `dsh prompt "$(cat task.txt)"` 这类 shell 组合。
