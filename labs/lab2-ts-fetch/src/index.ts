/**
 * TypeScript 项目骨架 + 网页 fetch 实验
 *
 * 单文件版本：类型定义、fetch 封装、本地测试服务、三个抓取场景都集中在这里，
 * 编译后只有 dist/index.js 一个入口，适合作为最基础的项目骨架。
 *
 * 常用命令：
 *   npm run build   tsc 编译到 dist/
 *   npm start       node dist/index.js
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/* ==================== 1. 类型定义 ==================== */

/** 统一的返回包装，泛型 T 描述真正的业务数据类型 */
interface ApiResult<T> {
  ok: boolean;
  status: number;
  costMs: number;
  data: T | null;
  error?: string;
}

/** 一次 HTTP 交互的原始快照 */
interface RawResponse {
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  costMs: number;
}

/** 接口返回中我们关心的字段 */
interface RepoInfo {
  id: number;
  full_name: string;
  language: string | null;
  stargazers_count: number;
}

/** 请求的可选配置 */
interface RequestOptions {
  timeout?: number;
  retries?: number;
  headers?: Record<string, string>;
}

/** 抓取任务 */
interface FetchTask {
  readonly name: string;
  readonly url: string;
}

/* ==================== 2. fetch 封装 ==================== */

const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9',
};

/** 发一次 GET，返回状态码 / 响应头 / 正文 / 耗时；内含超时中断与失败重试 */
async function fetchRaw(url: string, options: RequestOptions = {}): Promise<ApiResult<RawResponse>> {
  const { timeout = 8000, retries = 2, headers = {} } = options;
  let lastError = '';

  for (let attempt = 0; attempt <= retries; attempt++) {
    const startedAt = Date.now();
    // AbortController 是 fetch 唯一的「取消」入口，超时后 abort() 会中断底层连接
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response: Response = await fetch(url, {
        method: 'GET',
        headers: { ...DEFAULT_HEADERS, ...headers },
        redirect: 'follow',
        signal: controller.signal,
      });

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      // 第二次 await：把响应流读完并解码成字符串
      const body = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const costMs = Date.now() - startedAt;
      return {
        ok: true,
        status: response.status,
        costMs,
        data: {
          url: response.url || url,
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
          body,
          costMs,
        },
      };
    } catch (err) {
      lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      if (attempt < retries) {
        const wait = 400 * (attempt + 1);
        console.warn(`  · 第 ${attempt + 1} 次尝试失败（${lastError}），${wait}ms 后重试`);
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    } finally {
      clearTimeout(timer); // 不清掉的话进程会被悬挂的 timer 拖住
    }
  }

  return { ok: false, status: 0, costMs: 0, data: null, error: lastError };
}

/** 在 fetchRaw 之上解析 JSON，用泛型 T 约束结果形状 */
async function fetchJson<T>(url: string, options: RequestOptions = {}): Promise<ApiResult<T>> {
  const result = await fetchRaw(url, options);
  if (!result.ok || !result.data) return { ...result, data: null };
  try {
    return { ...result, data: JSON.parse(result.data.body) as T };
  } catch (err) {
    return {
      ok: false,
      status: result.status,
      costMs: result.costMs,
      data: null,
      error: `JSON 解析失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** 从 HTML 源码里提取 <title> */
function extractTitle(html: string): string | null {
  const matched = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return matched ? matched[1]!.trim().replace(/\s+/g, ' ') : null;
}

/* ==================== 3. 本地测试服务 ==================== */

interface MockServer {
  readonly port: number;
  readonly baseUrl: string;
  close(): Promise<void>;
}

const REPOS: Record<string, Omit<RepoInfo, 'id'>> = {
  'demo/alpha': { full_name: 'demo/alpha', stargazers_count: 12800, language: 'TypeScript' },
  'demo/beta': { full_name: 'demo/beta', stargazers_count: 9600, language: 'TypeScript' },
  'demo/gamma': { full_name: 'demo/gamma', stargazers_count: 4300, language: 'JavaScript' },
};

/** 起一个本地 HTTP 服务，每个请求固定延迟 delayMs，用来做稳定的耗时对比 */
function startMockServer(delayMs = 600): Promise<MockServer> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      const name = pathname.replace(/^\/api\/repos\//, '');
      const repo = REPOS[name];

      if (!repo) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Not Found' }));
        return;
      }

      setTimeout(() => {
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'x-mock-delay': String(delayMs),
        });
        res.end(JSON.stringify({ ...repo, id: Object.keys(REPOS).indexOf(name) + 1 }));
      }, delayMs);
    });

    server.on('error', reject);
    // 端口传 0 表示由系统分配空闲端口，避免端口冲突
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections(); // 避免 keep-alive 连接让 close 卡住
            server.close(() => done());
          }),
      });
    });
  });
}

/* ==================== 4. 三个场景 ==================== */

const SEP = '='.repeat(64);

function section(no: number, title: string): void {
  console.log();
  console.log(SEP);
  console.log(`场景 ${no}：${title}`);
  console.log(SEP);
}

function short(text: string, max = 60): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** 场景一：抓真实网页，读响应头并提取 <title> */
async function sceneHtmlPage(): Promise<void> {
  section(1, '抓取真实网页（https://www.baidu.com）');

  const result = await fetchRaw('https://www.baidu.com', { timeout: 10000 });
  if (!result.ok || !result.data) {
    console.log(`抓取失败：${result.error}`);
    return;
  }

  const { status, headers, body, costMs } = result.data;
  console.log(`状态码      : ${status}，耗时 ${costMs}ms`);
  console.log(`Content-Type: ${headers['content-type'] ?? '未提供'}`);
  console.log(`Server      : ${headers['server'] ?? '未提供'}`);
  console.log(`Content-Encoding: ${headers['content-encoding'] ?? '未压缩'}`);
  console.log(`响应体积    : ${(body.length / 1024).toFixed(1)} KB（已解码的文本长度）`);
  console.log(`页面标题    : ${extractTitle(body) ?? '未匹配到 <title>'}`);
  console.log(`正文预览    : ${short(body, 72)}`);
}

/** 场景二：抓 JSON 接口，用泛型把响应体约束成具体类型 */
async function sceneJsonApi(server: MockServer): Promise<void> {
  section(2, '抓取 JSON 接口并做类型约束');

  const url = `${server.baseUrl}/api/repos/demo/alpha`;
  const result = await fetchJson<RepoInfo>(url);
  if (!result.ok || !result.data) {
    console.log(`抓取失败：${result.error}`);
    return;
  }

  const repo = result.data;
  console.log(`接口地址    : ${url}`);
  console.log(`状态码      : ${result.status}，耗时 ${result.costMs}ms`);
  console.log(`仓库全名    : ${repo.full_name}`);
  console.log(`主语言      : ${repo.language ?? '未标注'}`);
  console.log(`Star 数     : ${repo.stargazers_count}`);
  console.log(`仓库 ID     : ${repo.id}`);
}

function printTaskResult(
  name: string,
  ok: boolean,
  status: number,
  costMs: number,
  error?: string,
): void {
  console.log(
    ok
      ? `  ✓ ${name.padEnd(18)} ${status}  ${String(costMs).padStart(5)}ms`
      : `  ✗ ${name.padEnd(18)} 失败  ${error ?? ''}`,
  );
}

/** 同一份任务列表，既可以串行跑，也可以并发跑 */
async function runTasks<T>(
  tasks: readonly FetchTask[],
  mode: 'serial' | 'parallel',
): Promise<number> {
  const begin = Date.now();

  if (mode === 'serial') {
    for (const task of tasks) {
      const result = await fetchJson<T>(task.url);
      printTaskResult(task.name, result.ok, result.status, result.costMs, result.error);
    }
  } else {
    const results = await Promise.all(tasks.map((task) => fetchJson<T>(task.url)));
    results.forEach((result, index) => {
      printTaskResult(tasks[index]!.name, result.ok, result.status, result.costMs, result.error);
    });
  }

  return Date.now() - begin;
}

/** 场景三：串行 vs 并发，直观理解事件循环与 I/O 等待 */
async function sceneSerialVsParallel(server: MockServer): Promise<void> {
  section(3, '串行 vs 并发（Promise.all）');
  console.log(`目标服务：${server.baseUrl}，每个请求固定延迟 600ms`);

  const tasks: readonly FetchTask[] = [
    { name: 'demo/alpha', url: `${server.baseUrl}/api/repos/demo/alpha` },
    { name: 'demo/beta', url: `${server.baseUrl}/api/repos/demo/beta` },
    { name: 'demo/gamma', url: `${server.baseUrl}/api/repos/demo/gamma` },
  ];

  console.log();
  console.log('▶ 串行：await 逐个执行，等待时间会被累加');
  const serialCost = await runTasks<RepoInfo>(tasks, 'serial');

  console.log();
  console.log('▶ 并发：Promise.all 同时发起，等待时间相互重叠');
  const parallelCost = await runTasks<RepoInfo>(tasks, 'parallel');

  console.log();
  console.log(`串行总耗时：${serialCost}ms`);
  console.log(`并发总耗时：${parallelCost}ms`);
  console.log(`加速比    ：${(serialCost / Math.max(parallelCost, 1)).toFixed(2)}x`);
}

/* ==================== 入口 ==================== */

async function main(): Promise<void> {
  console.log(`运行环境：Node ${process.version} / ${process.platform} ${process.arch}`);
  console.log(`全局 fetch：${typeof fetch === 'function' ? '内置可用（Node 18 起内置）' : '不可用'}`);
  console.log(`工作目录：${process.cwd()}`);

  const server = await startMockServer(600);
  console.log(`本地测试服务已启动：${server.baseUrl}`);

  try {
    await sceneHtmlPage();
    await sceneJsonApi(server);
    await sceneSerialVsParallel(server);
  } finally {
    await server.close();
    console.log();
    console.log('本地测试服务已关闭');
  }

  console.log(SEP);
  console.log('全部 fetch 任务执行完毕');
}

main().catch((err: unknown) => {
  console.error('脚本异常退出：', err);
  process.exitCode = 1;
});
