# 底层抓取能力说明

> [README](../README.md) 讲的是「模型怎么驱动工具」，本文讲的是「工具脚下的 Node `fetch` 到底怎么工作」。
> 全部结论都能用 `npm run demo:fetch` 在本地复现，不连外网、不需要 key。

## 为什么需要这份说明

内核的 `fetch_url` 工具只有几十行，但它把下面这些运行时事实全部压进了返回值里。要改工具、调超时、排查抓取异常，先得知道底层是什么行为。

## 六条运行时事实

| # | 事实 | 对项目的影响 |
| --- | --- | --- |
| 1 | Node 18 起 `fetch` 内置（基于 undici），无需 `node-fetch` | 项目可以做到零第三方运行时依赖 |
| 2 | `await fetch()` 兑现只代表**响应头到达**，正文还在传输；要再 `await resp.text() / arrayBuffer()` | 超时计时应覆盖两段，不能只算第一次 await |
| 3 | `resp.ok` 只对 2xx 为 true，**4xx / 5xx 不会 reject** | `fetch_url` 用 `isError: !resp.ok` 把 HTTP 错误变成模型能读懂的 tool 消息 |
| 4 | `AbortController` 是 fetch 唯一的取消入口，超时后 `abort()` 产生 `AbortError` | 工具能拿到 `ctx.signal`；但卡死的工具可能不理会它，所以 `agent-loop` 另外用 `Promise.race` 兜底 |
| 5 | 默认跟随重定向，最终地址在 `resp.url` | 白名单必须在跳转后**二次校验**，否则 302 可以绕过 `Scope` |
| 6 | 单线程 + 非阻塞 I/O，`await` 不阻塞主线程 | 串行时等待累加，并发时等待重叠；批量抓取应并发，但要用预算约束总量 |

补充一条 TypeScript 相关：类型在编译期被擦除，`JSON.parse` 的返回值**不会**被运行时校验，`fetchJson<T>` 里的 `T` 只是给写代码的人看的契约。

## 串行与并发的实测

在本地固定 600ms 延迟的服务上，对同一批 3 个接口分别跑 `for + await` 和 `Promise.all`：

```
串行总耗时：1811ms      ← 600 × 3
并发总耗时：608ms       ← max(600) + 调度开销
加速比    ：2.98x
```

`examples/fetch-basics.ts` 用的是 300ms 延迟、3 个接口，结论一致，只是绝对数值更小。之所以用本地服务而不是公网接口，是为了排除网络抖动对耗时对比的干扰。

## 与内核代码的对应关系

| 底层事实 | 内核落点 |
| --- | --- |
| 两段式读取 + 状态码 | `src/tools/builtin/web.ts` 的 `fetchUrlTool.run` |
| 重定向后复查主机 | 同上，`ctx.scope.canFetchUrl(finalUrl)` |
| HTTP 错误也是结果 | 同上，`isError: !resp.ok` → 回填 `tool` 消息 |
| 超时兜底 | `src/agent-loop/` 的 `Promise.race` |
| 工具白名单 / 预算 | `src/scope/` |
| 输出落盘防目录穿越 | `src/tools/builtin/web.ts` 的 `saveMarkdownTool.run`（`resolve` 限定在 `out/`） |

## 还没覆盖的能力

这份自检只验证「单个请求怎么发、怎么算失败」。真实爬取任务还缺：限速与礼貌抓取（`robots.txt`）、去重与 URL 归一化、分页 / 渲染、断点续爬、会话持久化。这些属于项目后续要补的能力，见 [README 的路线图](../README.md#现状与路线图)。
