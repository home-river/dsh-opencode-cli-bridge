/** 方案 A「切块模拟流式」的默认切片宽度（Unicode 码点数）。 */
export const DEFAULT_CHUNK_SIZE = 24;

/**
 * 把整段正文切成 text-delta 小片。
 * 按 Unicode 码点切分，绝不拆散代理对；不增删任何字符，拼接结果恒等于原文。
 */
export function chunkText(text: string, chunkSize: number = DEFAULT_CHUNK_SIZE): string[] {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new TypeError(`chunkSize must be a positive integer, got ${String(chunkSize)}`);
  }
  if (text === "") return [];
  const points = Array.from(text);
  const out: string[] = [];
  for (let i = 0; i < points.length; i += chunkSize) {
    out.push(points.slice(i, i + chunkSize).join(""));
  }
  return out;
}
