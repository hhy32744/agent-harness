/**
 * 底层抓取能力自检：本地 mock 站点 + Node 内置 fetch。
 *
 * 不连外网、不需要 API key，用来验证内核 `fetch_url` 工具所依赖的运行时事实：
 * 响应头/响应体的两段式读取、4xx 不 reject、AbortController 超时、JSON 泛型解析、
 * 串行与并发的 I/O 等待差异。
 *
 *   npm run demo:fetch
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

interface RawResponse {
  status: number;
  ok: boolean;
  contentType: string | null;
  body: string;
  headersMs: number;
  totalMs: number;
}

interface Repo {
  id: number;
  full_name: string;
  language: string | null;
  stars: number;
}

interface MockSite {
  baseUrl: string;
  close(): Promise<void>;
}

const REPOS: Record<string, Repo> = {
  "demo/alpha": { id: 1, full_name: "demo/alpha", language: "TypeScript", stars: 12800 },
  "demo/beta": { id: 2, full_name: "demo/beta", language: "TypeScript", stars: 9600 },
  "demo/gamma": { id: 3, full_name: "demo/gamma", language: "JavaScript", stars: 4300 },
};

/** 起一个本地站点，每个正常请求固定延迟 delayMs，让耗时对比稳定可复现 */
function startSite(delayMs = 300): Promise<MockSite> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      const reply = (status: number, type: string, body: string): void => {
        res.writeHead(status, { "content-type": type });
        res.end(body);
      };

      if (pathname === "/page") {
        setTimeout(
          () => reply(200, "text/html; charset=utf-8", "<html><head><title>本地示例页</title></head><body><a href=\"/api/repos/demo/alpha\">alpha</a></body></html>"),
          delayMs,
        );
        return;
      }
      if (pathname === "/missing") {
        reply(404, "text/plain; charset=utf-8", "Not Found");
        return;
      }
      if (pathname === "/slow") {
        // 客户端 abort 后 socket 可能已销毁，写之前先判断，避免无谓报错。
        // unref 掉这个定时器，免得自检结束后还白白等 1.5 秒才退出。
        const timer = setTimeout(() => {
          if (!res.destroyed) reply(200, "text/plain; charset=utf-8", "终于回来了");
        }, 1500);
        timer.unref?.();
        return;
      }
      const name = pathname.replace(/^\/api\/repos\//, "");
      const repo = REPOS[name];
      if (repo) {
        setTimeout(() => reply(200, "application/json; charset=utf-8", JSON.stringify(repo)), delayMs);
        return;
      }
      reply(404, "application/json; charset=utf-8", JSON.stringify({ message: "Not Found" }));
    });

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

/** 一次 GET：分别记录「响应头到达」和「正文读完」两个时刻 */
async function fetchRaw(url: string, timeoutMs = 3000): Promise<RawResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const resp = await fetch(url, { signal: controller.signal, redirect: "follow" });
    const headersMs = Date.now() - started;
    const body = await resp.text();
    return {
      status: resp.status,
      ok: resp.ok,
      contentType: resp.headers.get("content-type"),
      body,
      headersMs,
      totalMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const raw = await fetchRaw(url);
  if (!raw.ok) throw new Error(`HTTP ${raw.status}`);
  return JSON.parse(raw.body) as T;
}

const SEP = "=".repeat(64);
function section(title: string): void {
  console.log(`\n${SEP}\n${title}\n${SEP}`);
}

async function sceneTwoPhases(base: string): Promise<void> {
  section("1 / 响应头到达 ≠ 正文读完");
  const raw = await fetchRaw(`${base}/page`);
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw.body)?.[1] ?? "未匹配";
  console.log(`状态码 ${raw.status} · Content-Type ${raw.contentType}`);
  console.log(`响应头 ${raw.headersMs}ms → 正文读完 ${raw.totalMs}ms · ${raw.body.length} 字符`);
  console.log(`页面标题：${title}`);
}

async function sceneStatus(base: string): Promise<void> {
  section("2 / 4xx 不会让 fetch reject");
  const raw = await fetchRaw(`${base}/missing`);
  console.log(`fetch 正常兑现，status=${raw.status}，response.ok=${raw.ok}`);
  console.log("→ 必须自己判断 ok，内核 fetch_url 用 isError: !resp.ok 把它变成错误消息");
}

async function sceneTimeout(base: string): Promise<void> {
  section("3 / AbortController 是 fetch 的取消入口");
  try {
    await fetchRaw(`${base}/slow`, 200);
    console.log("意外：超时没有生效");
  } catch (err) {
    console.log(`200ms 超时触发：${err instanceof Error ? err.name : String(err)}`);
  }
  console.log("→ 工具若根本不理会 signal，还需 agent-loop 用 Promise.race 从外部兜底");
}

async function sceneJson(base: string): Promise<void> {
  section("4 / JSON 接口与泛型约束");
  const repo = await fetchJson<Repo>(`${base}/api/repos/demo/alpha`);
  console.log(`${repo.full_name} · ${repo.language} · ${repo.stars} stars · id=${repo.id}`);
  console.log("→ 类型只在编译期存在，运行时不做校验，接口契约要自己保证");
}

async function runTasks(urls: readonly string[], mode: "serial" | "parallel"): Promise<number> {
  const started = Date.now();
  if (mode === "serial") {
    for (const url of urls) await fetchJson<Repo>(url);
  } else {
    await Promise.all(urls.map((url) => fetchJson<Repo>(url)));
  }
  return Date.now() - started;
}

async function sceneConcurrency(base: string): Promise<void> {
  section("5 / 串行 vs 并发（Promise.all）");
  const urls = Object.keys(REPOS).map((name) => `${base}/api/repos/${name}`);
  const serial = await runTasks(urls, "serial");
  const parallel = await runTasks(urls, "parallel");
  console.log(`串行 ${serial}ms  ≈ 单次延迟 × ${urls.length}`);
  console.log(`并发 ${parallel}ms ≈ 单次延迟 + 调度开销`);
  console.log(`加速比 ${(serial / Math.max(parallel, 1)).toFixed(2)}x`);
}

async function main(): Promise<void> {
  console.log(`运行环境：Node ${process.version} / ${process.platform} ${process.arch}`);
  console.log(`全局 fetch：${typeof fetch === "function" ? "内置可用" : "不可用"}`);
  const site = await startSite(300);
  console.log(`本地站点：${site.baseUrl}（全部请求不出网）`);
  try {
    await sceneTwoPhases(site.baseUrl);
    await sceneStatus(site.baseUrl);
    await sceneTimeout(site.baseUrl);
    await sceneJson(site.baseUrl);
    await sceneConcurrency(site.baseUrl);
  } finally {
    await site.close();
  }
  console.log(`\n${SEP}\n底层抓取能力自检完成\n${SEP}`);
}

main().catch((err: unknown) => {
  console.error("自检异常：", err);
  process.exitCode = 1;
});
