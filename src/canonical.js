import { invalidRequest } from "./errors.js";

// 嵌套对象也按键排序，重传内容比对与日志哈希不受字段书写顺序影响
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

export function parseInstant(value, label = "时间") {
  if (typeof value !== "string" || !value.trim()) throw invalidRequest(`${label}必须是 ISO 8601 时间字符串`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw invalidRequest(`${label}无法解析: ${value}`);
  return ms;
}

export const round3 = (n) => Math.round(n * 1000) / 1000;
