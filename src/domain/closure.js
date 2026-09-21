// 官方封闭：拥有自己独立的生效区间 [effectiveFrom, effectiveTo)。
// effectiveTo 为 null 表示开放期未定（持续封闭）。封闭不由任何观测覆盖或撤销。
import { parseInstant } from "./time.js";

export function defineClosure(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("封闭记录必须是对象");
  }
  const { closureId, waterPointId, authority, reason, effectiveFrom } = input;
  for (const [key, value] of [
    ["closureId", closureId],
    ["waterPointId", waterPointId],
    ["authority", authority],
    ["reason", reason],
  ]) {
    if (typeof value !== "string" || !value.trim()) throw new TypeError(`${key} 不完整`);
  }
  const from = parseInstant(effectiveFrom, "effectiveFrom");
  const to = input.effectiveTo == null ? null : parseInstant(input.effectiveTo, "effectiveTo");
  if (to != null && to <= from) {
    throw new TypeError("effectiveTo 必须晚于 effectiveFrom");
  }
  return {
    closureId,
    waterPointId,
    authority,
    reason,
    effectiveFrom: from,
    effectiveTo: to,
    issuedAt: input.issuedAt == null ? from : parseInstant(input.issuedAt, "issuedAt"),
    details: Object.fromEntries(
      Object.entries(input).filter(([k]) =>
        !["closureId", "waterPointId", "authority", "reason", "effectiveFrom", "effectiveTo", "issuedAt"].includes(k))
    ),
  };
}

export function closureActiveAt(closure, atMs) {
  if (atMs < closure.effectiveFrom) return false;
  if (closure.effectiveTo != null && atMs >= closure.effectiveTo) return false;
  return true;
}
