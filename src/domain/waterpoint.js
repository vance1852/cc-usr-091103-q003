// 水点实体注册。位置、坐标精度与未知属性原样保留（契约边界）。
import { parseInstant } from "./time.js";

export function defineWaterPoint(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("水点定义必须是对象");
  }
  const { waterPointId, name, location } = input;
  if (typeof waterPointId !== "string" || !waterPointId.trim()) {
    throw new TypeError("waterPointId 不完整");
  }
  if (typeof name !== "string" || !name.trim()) {
    throw new TypeError("水点名称不完整");
  }
  if (!location || typeof location !== "object" || Array.isArray(location)) {
    throw new TypeError("水点位置必须是对象");
  }
  if (typeof location.description !== "string" || !location.description.trim()) {
    throw new TypeError("水点位置描述不完整");
  }
  const wp = {
    waterPointId,
    name,
    location, // 含 description，以及可选 coordinates、elevation 等未知属性
    // 顶层未知属性同样原样保留（与观测契约的 details 同口径）。
    details: Object.fromEntries(
      Object.entries(input).filter(([k]) => !["waterPointId", "name", "location", "createdAt"].includes(k))
    ),
  };
  if (input.createdAt) {
    wp.createdAt = parseInstant(input.createdAt, "createdAt");
  }
  return wp;
}
