/**
 * 工具参数的读取与校验。
 *
 * 模型给的参数永远是"不可信输入"：可能是字符串数字、可能是空串、可能缺字段。
 * 这里把校验收敛成三个小函数，报错文案统一成一句中文，方便模型读懂后自我修正。
 */

export function readString(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string" || v.trim() === "") throw new Error(`参数 ${key} 必须是非空字符串`);
  return v.trim();
}

export function readNumber(input: Record<string, unknown>, key: string, fallback: number): number {
  const v = input[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** 把数字夹到 [min, max]，避免模型传个 1e9 把内存吃满 */
export function clampNumber(v: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(v), min), max);
}

/** 去掉标签、解掉常见 HTML 实体、压缩空白 —— 搜索结果标题和摘要都用它 */
export function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  middot: "·",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
  "#39": "'",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
    const key = name.toLowerCase();
    const code = key.startsWith("#x")
      ? parseInt(key.slice(2), 16)
      : key.startsWith("#")
        ? parseInt(key.slice(1), 10)
        : NaN;
    if (!Number.isNaN(code)) return String.fromCodePoint(code);
    return ENTITIES[key] ?? whole;
  });
}
