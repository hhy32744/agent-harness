/**
 * Scope：agent 的"活动边界"。
 *
 * 一个爬虫 agent 最危险的不是模型答错，而是它照着网页里的提示词
 * 去访问内网地址、或者无限翻页烧钱。所以在 core 里把三件事收成策略：
 *   1) 能用哪些工具（工具白名单）
 *   2) 能访问哪些主机（爬虫的域名白名单）
 *   3) 最多转几轮 / 调几次工具（成本闸门）
 *
 * Scope 只做判定，不做执行；执行发生在 ToolRegistry 里。
 */

export interface ScopePolicy {
  /** 允许调用的工具名；undefined 表示不限制 */
  allowedTools?: string[];
  /** 明确禁用的工具名，优先级高于 allowedTools */
  deniedTools?: string[];
  /** 允许抓取的主机名白名单，支持 `example.com` 与 `*.example.com`；undefined 表示不限制 */
  allowedHosts?: string[];
  /** agent loop 的最大轮次 */
  maxTurns: number;
  /** 整个会话最多允许的工具调用次数 */
  maxToolCalls: number;
  /** 单次工具输出回填给模型的字符上限，防止把上下文撑爆 */
  maxOutputChars: number;
  /** 单次工具执行超时（毫秒） */
  toolTimeoutMs: number;
}

export interface CheckResult {
  allowed: boolean;
  reason?: string;
}

const DEFAULT_POLICY: ScopePolicy = {
  maxTurns: 8,
  maxToolCalls: 16,
  maxOutputChars: 8000,
  toolTimeoutMs: 15000,
};

export class Scope {
  readonly policy: ScopePolicy;

  constructor(policy: Partial<ScopePolicy> = {}) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
  }

  /** 爬虫场景的预设：只允许抓白名单域名 + 三个抓取类工具 */
  static crawler(hosts: string[], overrides: Partial<ScopePolicy> = {}): Scope {
    return new Scope({
      allowedTools: ["fetch_url", "extract_links", "save_markdown"],
      allowedHosts: hosts,
      maxTurns: 8,
      maxToolCalls: 12,
      maxOutputChars: 6000,
      toolTimeoutMs: 10000,
      ...overrides,
    });
  }

  canUseTool(name: string): CheckResult {
    const { deniedTools, allowedTools } = this.policy;
    if (deniedTools?.includes(name)) {
      return { allowed: false, reason: `工具 ${name} 在禁用列表中` };
    }
    if (allowedTools && !allowedTools.includes(name)) {
      return { allowed: false, reason: `工具 ${name} 不在白名单 ${allowedTools.join(",")} 中` };
    }
    return { allowed: true };
  }

  /** 主机白名单判定，`*.example.com` 同时匹配子域 */
  canFetchHost(hostname: string): CheckResult {
    const allow = this.policy.allowedHosts;
    if (!allow) return { allowed: true };
    const host = hostname.toLowerCase();
    for (const pattern of allow) {
      const p = pattern.toLowerCase();
      if (p === host) return { allowed: true };
      if (p.startsWith("*.") && (host === p.slice(2) || host.endsWith(p.slice(1)))) {
        return { allowed: true };
      }
    }
    return { allowed: false, reason: `主机 ${hostname} 不在抓取白名单 ${allow.join(",")} 中` };
  }

  canFetchUrl(raw: string): CheckResult {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { allowed: false, reason: `不是合法的绝对 URL：${raw}` };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { allowed: false, reason: `只允许 http/https，收到 ${url.protocol}` };
    }
    return this.canFetchHost(url.hostname);
  }
}
