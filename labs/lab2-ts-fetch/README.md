# ts-fetch-lab

TypeScript 项目骨架 + Node 环境下的网页抓取（fetch）实验。

## 一、目录结构

```
ts-fetch-lab/
├─ src/
│  └─ index.ts        唯一源码文件，内部按四段组织：
│                       1) 类型定义   2) fetch 封装
│                       3) 本地测试服务   4) 三个抓取场景 + 出口
├─ dist/              tsc 编译产物（npm run build 后生成 index.js / index.d.ts）
├─ package.json       npm 脚本与依赖
├─ tsconfig.json      TypeScript 编译配置
└─ .gitignore         忽略 node_modules / dist
```

`src` 下只放一个 `index.ts`，是因为这次实验的重点是「骨架 + fetch 链路」，不是工程分层。
真要拆的话，按注释里的四段拆成 `types.ts` / `http.ts` / `mock-server.ts` / `index.ts` 即可。

## 二、环境准备

```bash
node -v          # 需要 >= 18（内置 fetch）；本次实验为 v22.22.2
npm -v           # 10.9.7
npm install      # 安装 typescript / ts-node / @types/node
```

## 三、常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 用 tsc 把 `src/*.ts` 编译成 `dist/*.js` |
| `npm start` | 运行编译后的 `dist/index.js` |
| `npm run typecheck` | 只做类型检查，不产出文件（`tsc --noEmit`） |
| `npm run dev` | 监听模式编译（`tsc --watch`） |
| `npm run clean` | 删除 `dist` 目录 |

## 四、三个实验场景

1. **抓取真实网页**：GET `https://www.baidu.com`，打印状态码、响应头、体积，并用正则提取 `<title>`。
2. **抓取 JSON 接口**：GET 本地服务的 `/api/repos/demo/alpha`，用泛型 `fetchJson<RepoInfo>` 约束响应体结构。
3. **串行 vs 并发**：对同一批 3 个接口，分别用 `for + await` 和 `Promise.all` 请求，比较总耗时。

本地服务每个请求固定延迟 600ms，因此第 3 个场景的结论是稳定的：

```
串行总耗时：1811ms      ← 600 × 3
并发总耗时：608ms       ← max(600) + 调度开销
加速比    ：2.98x
```

## 五、运行原理要点

1. **fetch 是 Web 标准 API**，Node 18 起内置（基于 undici 实现），无需再装 `node-fetch`。
2. `fetch()` 返回 `Promise<Response>`：Promise 兑现只代表**响应头已经到达**，响应体还在网络中传输，必须再 `await response.text() / json()` 才能读到正文。
3. `response.ok` 只对 2xx 为 true；4xx/5xx **不会** reject，必须自己判断。
4. `AbortController` 是 fetch 唯一的取消入口，把 `signal` 传进去，超时后 `abort()` 会中断底层连接（时报 `AbortError`）。
5. **单线程 + 非阻塞 I/O**：JS 主线程不会因为 `await` 而阻塞。串行时三次等待依次排队，并发时三个请求同时在途、等待时间重叠，所以总耗时接近单次耗时。
6. **TypeScript 的类型只在编译期存在**，`tsc` 把类型擦除后产出 `.js`；运行时拿到的 JSON 不会被校验，仍需自己保证接口契约。

## 六、说明

- 沙箱/公司网络若需代理，Node 的 `fetch` 默认不读取 `HTTP_PROXY` 环境变量，需要显式配置 dispatcher（可安装 `undici` 后 `setGlobalDispatcher(new ProxyAgent(...))`）。
- 本实验第 2、3 个场景使用本地服务而非公网接口，是为了排除网络抖动对耗时对比的干扰。
