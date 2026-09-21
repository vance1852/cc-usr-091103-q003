import { parseInstant, round3 } from "../canonical.js";
import { reportsFor, closuresFor } from "./projection.js";

// 判断口径版本号：任何权重/TTL 调整都升版本，并随响应返回，保证推导依据可追溯
export const CONSTANTS_VERSION = "water-assessment-v1";

// 各流量等级观测的有效时长（小时）：强流量变化最慢，断流可能因降雨最快改变
export const DEFAULT_TTL_HOURS = { dry: 72, trickle: 48, usable: 96, strong: 168 };

// 来源可信度权重。护林员/官方最高，沿线客栈等在地观察者次之，徒步者为基线。
// observerType 是开放字符串（契约边界），未登记来源统一按基线 1 处理。
const SOURCE_TRUST = {
  ranger: 3,
  "forest-ranger": 3,
  "park-ranger": 3,
  official: 3,
  authority: 3,
  "lodging-host": 2,
  innkeeper: 2,
  inn: 2,
  guesthouse: 2,
  shepherd: 2,
  local: 2,
  hiker: 1,
  trekker: 1,
  climber: 1,
};

// 两类对立证据势均力敌到什么程度就判“有争议”（次强方 ≥ 最强方 × 该系数）
const CONTEST_RATIO = 0.6;

export function sourceTrust(observerType) {
  const key = String(observerType).trim().toLowerCase().replace(/_/g, "-");
  return SOURCE_TRUST[key] ?? 1;
}

const clamp01 = (n) => Math.min(1, Math.max(0, n));

function ttlHoursFor(point, flowLevel) {
  if (typeof point?.ttlHours === "number" && Number.isFinite(point.ttlHours) && point.ttlHours > 0) {
    return point.ttlHours;
  }
  return DEFAULT_TTL_HOURS[flowLevel];
}

function activeClosure(closures, atMs) {
  return (
    closures.find((c) => {
      const start = parseInstant(c.startAt, "closure.startAt");
      const end = c.endAt == null ? null : parseInstant(c.endAt, "closure.endAt");
      return start <= atMs && (end === null || atMs < end);
    }) ?? null
  );
}

// 纯函数：结论只取决于（投影状态, 水点, 时刻）。同一事件日志、同一时刻，永远同一结论。
export function assessWaterPoint(state, waterPointId, atMs) {
  const point = state.waterPoints.get(waterPointId);
  if (!point) return null;

  const reports = reportsFor(state, waterPointId);
  const evidence = reports.map((report) => {
    const observedMs = parseInstant(report.observedAt, "observedAt");
    const receivedMs = parseInstant(report.receivedAt, "receivedAt");
    const ttlHours = ttlHoursFor(point, report.flowLevel);
    const ageHours = (atMs - observedMs) / 3_600_000;
    const fresh = ageHours < ttlHours;
    const trust = sourceTrust(report.observerType);
    const retractions = state.retractionsByReport.get(report.reportId) ?? [];
    const retracted = retractions.length > 0;
    const weight = !retracted && fresh ? round3(trust * clamp01(1 - ageHours / ttlHours)) : 0;

    return {
      reportId: report.reportId,
      observerType: report.observerType,
      observedAt: report.observedAt,
      receivedAt: report.receivedAt,
      ingestSeq: report.ingestSeq,
      flowLevel: report.flowLevel,
      evidenceDigest: report.details?.evidenceDigest ?? null,
      note: report.details?.note ?? null,
      details: report.details, // 未知属性原样保留
      sourceTrust: trust,
      ageHours: round3(ageHours),
      ttlHours,
      fresh,
      freshness: round3(clamp01(1 - ageHours / ttlHours)),
      weight,
      expiresAt: new Date(observedMs + ttlHours * 3_600_000).toISOString(),
      retracted,
      retractions: retractions.map(({ reason, source, note, recordedAt }) => ({
        reason,
        source: source ?? null,
        note: note ?? null,
        recordedAt,
      })),
      reportLagHours: round3((receivedMs - observedMs) / 3_600_000),
    };
  });

  // 证据的确定顺序只认观测时刻（reportsFor 已排序），与 receivedAt / ingestSeq 无关
  const scoring = evidence.filter((e) => e.weight > 0);
  const scores = { wet: 0, trickle: 0, dry: 0 };
  for (const e of scoring) {
    if (e.flowLevel === "usable" || e.flowLevel === "strong") scores.wet = round3(scores.wet + e.weight);
    else if (e.flowLevel === "trickle") scores.trickle = round3(scores.trickle + e.weight);
    else scores.dry = round3(scores.dry + e.weight);
  }

  const total = round3(scores.wet + scores.trickle + scores.dry);
  let verdict;
  if (total === 0) {
    verdict = {
      status: "unknown",
      contested: false,
      confidence: 0,
      reason: scoring.length === 0 && evidence.length === 0
        ? "没有任何观测"
        : "所有观测均已超过有效时长或被撤回，当前没有可采信证据",
      decisiveReportIds: [],
    };
  } else {
    const ranked = [
      ["wet", scores.wet],
      ["trickle", scores.trickle],
      ["dry", scores.dry],
    ].sort((a, b) => b[1] - a[1]);
    const [topClass, topScore] = ranked[0];
    const secondScore = ranked[1][1];
    const contested = secondScore > 0 && secondScore >= topScore * CONTEST_RATIO;
    const decisiveReportIds = scoring
      .filter((e) => (topClass === "wet" ? ["usable", "strong"].includes(e.flowLevel) : e.flowLevel === topClass))
      .map((e) => e.reportId);
    const statusMap = { wet: "reliable", trickle: "marginal", dry: "unreliable" };
    verdict = {
      status: contested ? "contested" : statusMap[topClass],
      contested,
      confidence: round3(topScore / total),
      reason: contested
        ? `支持与反对的新鲜证据势均力敌（${scores.wet} / ${scores.trickle} / ${scores.dry}），不能按到达先后取一条`
        : topClass === "wet"
          ? "新鲜证据显示水量可用"
          : topClass === "trickle"
            ? "最新鲜证据仅为细流，补水耗时且不保证"
            : "新鲜证据显示已经断流",
      decisiveReportIds,
    };
  }

  // 结论衰减点：当前参与判定的证据中，最早一个掉到 TTL 之外的时刻；此后结论可能改变
  const expiresAtMs = scoring.length
    ? Math.min(...scoring.map((e) => Date.parse(e.expiresAt)))
    : null;

  const closures = closuresFor(state, waterPointId);
  const closureNow = activeClosure(closures, atMs);
  const nextClosure = closures
    .filter((c) => parseInstant(c.startAt) > atMs)
    .sort((a, b) => parseInstant(a.startAt) - parseInstant(b.startAt))[0] ?? null;

  const status = closureNow ? "closed" : verdict.status;

  return {
    waterPointId,
    name: point.name ?? null,
    location: point.location ?? null,
    asOf: new Date(atMs).toISOString(),
    status, // closed | reliable | contested | marginal | unreliable | unknown
    reliable: status === "reliable",
    verdict,
    scores,
    // 结论何时开始衰减（不再有任何新鲜证据保证时为 null）
    conclusionExpiresAt: expiresAtMs ? new Date(expiresAtMs).toISOString() : null,
    stale: scoring.length === 0,
    closure: closureNow
      ? {
          closureId: closureNow.closureId,
          startAt: closureNow.startAt,
          endAt: closureNow.endAt,
          reason: closureNow.reason,
          issuedBy: closureNow.issuedBy,
        }
      : null,
    nextClosure: nextClosure
      ? {
          closureId: nextClosure.closureId,
          startAt: nextClosure.startAt,
          endAt: nextClosure.endAt,
          reason: nextClosure.reason,
        }
      : null,
    evidence: {
      // 支持“可依赖”的原始观测
      supporting: evidence.filter((e) => ["usable", "strong"].includes(e.flowLevel)),
      // 细流：有水但不能当作可靠补水
      caution: evidence.filter((e) => e.flowLevel === "trickle"),
      // 反对“可依赖”的原始观测（断流）
      opposing: evidence.filter((e) => e.flowLevel === "dry"),
    },
  };
}
