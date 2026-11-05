/**
 * 演示用的本地站点：只有三个页面，用来让爬虫 agent 有东西可抓。
 * 起在随机端口上，避免和外网/其他进程冲突，同时让 demo 不依赖网络。
 */
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

const PAGES: Record<string, { title: string; body: string }> = {
  "/": {
    title: "实验室主页",
    body: `
      <h1>大数据实验室</h1>
      <p>本周更新：三个课题的进展记录。</p>
      <ul>
        <li><a href="/article/1">课题一：基于 Agent 的网页信息抽取</a></li>
        <li><a href="/article/2">课题二：DeepSeek 函数调用的失败模式</a></li>
        <li><a href="/about">关于我们</a></li>
      </ul>`,
  },
  "/article/1": {
    title: "课题一：基于 Agent 的网页信息抽取",
    body: `
      <h1>课题一：基于 Agent 的网页信息抽取</h1>
      <p>目标是让模型自己决定抓哪个链接、抓几次、什么时候停。</p>
      <p>关键点：工具白名单、域名白名单、轮次预算。</p>
      <a href="/">返回首页</a>`,
  },
  "/article/2": {
    title: "课题二：DeepSeek 函数调用的失败模式",
    body: `
      <h1>课题二：DeepSeek 函数调用的失败模式</h1>
      <p>常见问题：参数 JSON 截断、同名工具重复调用、忘记回填 tool_call_id。</p>
      <a href="/">返回首页</a>`,
  },
  "/about": {
    title: "关于我们",
    body: `<h1>关于我们</h1><p>实验室成立于 2019 年，关注数据系统与智能体。</p><a href="/">返回首页</a>`,
  },
};

export interface MockSite {
  baseUrl: string;
  close: () => Promise<void>;
}

export async function startMockSite(): Promise<MockSite> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const page = PAGES[path];
    if (!page) {
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      res.end(`<h1>404</h1><p>${path} 不存在</p>`);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><title>${page.title}</title></head><body>${page.body}</body></html>`);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
