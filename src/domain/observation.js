// 观测接入层：复用仓库契约 src/water-report.js 的 readWaterReport 作为唯一校验入口，
// 契约未知字段（evidenceDigest、note、照片、坐标等）全部落在 details 中原样保存。
import { readWaterReport } from "../water-report.js";
import { parseInstant } from "./time.js";

// 来源类型与基准可信度：护林员（现场管理者）> 客栈（长期驻点）> 徒步者（过境目击）。
// 注意：可信度不同绝不等于“按到达先后覆盖”，三方报告同时作为证据进入加权结论。
export const SOURCE_PROFILES = {
  ranger:       { label: "护林员",   baseWeight: 1.0, stalenessMs: 3 * 864e5 },
  "lodging-host": { label: "客栈",  baseWeight: 0.8, stalenessMs: 4 * 864e5 },
  hiker:        { label: "徒步者",   baseWeight: 0.5, stalenessMs: 2 * 864e5 },
};

export function ingestObservation(input) {
  // 契约负责结构校验；这里不复制其规则，只做领域层需要的时间解析。
  const report = readWaterReport(input);
  const observedAt = parseInstant(report.observedAt, "observedAt");
  const receivedAt = parseInstant(report.receivedAt, "receivedAt");
  if (observedAt > receivedAt) {
    throw new TypeError("observedAt 不能晚于 receivedAt");
  }
  const profile = SOURCE_PROFILES[report.observerType] ?? {
    label: report.observerType,
    baseWeight: 0.3,
    stalenessMs: 2 * 864e5,
  };
  return {
    reportId: report.reportId,
    waterPointId: report.waterPointId,
    observerType: report.observerType,
    sourceLabel: profile.label,
    observedAt,
    receivedAt,
    flowLevel: report.flowLevel,
    // details 含 evidenceDigest、note 以及一切契约外字段，未知属性可靠保存。
    details: report.details,
    raw: report,
  };
}

// 撤回：只引用原观测并追加说明，绝不修改或删除原报告内容。
export function defineRetraction(input) {
  if (!input || typeof input !== "object") throw new TypeError("撤回必须是对象");
  const { retractionId, reportId, waterPointId, reason } = input;
  for (const [key, value] of [["retractionId", retractionId], ["reportId", reportId], ["waterPointId", waterPointId], ["reason", reason]]) {
    if (typeof value !== "string" || !value.trim()) throw new TypeError(`${key} 不完整`);
  }
  return {
    retractionId,
    reportId,
    waterPointId,
    reason,
    receivedAt: parseInstant(input.receivedAt, "receivedAt"),
    details: Object.fromEntries(
      Object.entries(input).filter(([k]) =>
        !["retractionId", "reportId", "waterPointId", "reason", "receivedAt"].includes(k))
    ),
  };
}
