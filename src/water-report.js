const FLOW_LEVELS = new Set(["dry", "trickle", "usable", "strong"]);

export function readWaterReport(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("观测报告必须是对象");
  const { reportId, waterPointId, observerType, observedAt, receivedAt, flowLevel } = value;
  if (![reportId, waterPointId, observerType, observedAt, receivedAt].every((item) => typeof item === "string" && item.trim())) throw new TypeError("观测报告标识或时间不完整");
  if (!FLOW_LEVELS.has(flowLevel)) throw new TypeError("未知流量等级");
  const base = ["reportId", "waterPointId", "observerType", "observedAt", "receivedAt", "flowLevel"];
  return { ...value, details: Object.fromEntries(Object.entries(value).filter(([key]) => !base.includes(key))) };
}
