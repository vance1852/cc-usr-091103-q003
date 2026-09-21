// 时刻解析与规范化：一切内部时间均为 epoch 毫秒，对外输出 UTC ISO-8601。
// 要求输入显式携带时区，避免“裸时间”在不同部署时区下产生歧义。

export function parseInstant(value, field = "时间") {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${field}必须是非空字符串`);
  }
  const text = value.trim();
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) {
    throw new TypeError(`${field}不是合法的时刻: ${value}`);
  }
  if (!/[zZ]$/.test(text) && !/[+-]\d{2}:?\d{2}$/.test(text)) {
    throw new TypeError(`${field}必须显式携带时区(如 Z 或 +08:00): ${value}`);
  }
  return ms;
}

export function toIso(ms) {
  return new Date(ms).toISOString();
}
