// 结论层：在某一时刻 atMs 评估水点“此刻是否值得依赖”。
// 设计原则：
//  - 任何来源的报告都不覆盖另一来源；结论由全部未撤回、未过期证据加权得出；
//  - 证据的规范顺序只取 (observedAt, reportId)，与到达先后(receivedAt/写入顺序)无关；
//  - 撤回按“追加说明”处理：被撤回报告移出加权，仍在审计区列出；
//  - 官方封闭有独立生效区间，封闭期间状态直接为 closed，但证据照常展示；
//  - 所有输出只依赖 (状态, atMs)，同一状态同一时刻永远得到同一结论（重启可复现）。
import { SOURCE_PROFILES } from "./observation.js";
import { closureActiveAt } from "./closure.js";
import { toIso } from "./time.js";

const FLOW_SCORE = { strong: 1, usable: 0.7, trickle: 0.35, dry: 0 };
const RELIABLE = 0.66;
const UNRELIABLE = 0.33;
const round4 = (n) => Math.round(n * 1e4) / 1e4;

// 证据的确定顺序：观测时刻为主序，reportId 为次序。迟到报告不会改变既有顺序。
export function evidenceOrder(a, b) {
  if (a.observedAt !== b.observedAt) return a.observedAt - b.observedAt;
  return a.reportId < b.reportId ? -1 : a.reportId > b.reportId ? 1 : 0;
}

function profileOf(observerType) {
  return SOURCE_PROFILES[observerType] ?? { label: observerType, baseWeight: 0.3, stalenessMs: 2 * 864e5 };
}

// atMs 时点可知的撤回：按 receivedAt 生效（行程复刻到达时刻时，未来的行政撤回尚未生效）。
function retractionsKnownAt(retractions, atMs) {
  const map = new Map();
  for (const r of retractions) {
    if (r.receivedAt > atMs) continue;
    const prev = map.get(r.reportId);
    if (!prev || r.receivedAt < prev.receivedAt) map.set(r.reportId, r);
  }
  return map;
}

function decorate(obs, atMs) {
  const profile = profileOf(obs.observerType);
  const age = atMs - obs.observedAt;
  const expiresAt = obs.observedAt + profile.stalenessMs;
  const score = FLOW_SCORE[obs.flowLevel];
  // 观测时刻晚于评估时刻的证据不计入（到达时不可能预知），但保留在列表中标记 future。
  let factor = 0;
  let phase = "stale";
  if (age < 0) phase = "future";
  else if (age >= profile.stalenessMs) phase = "stale";
  else {
    factor = 1 - age / profile.stalenessMs;
    phase = "active";
  }
  const weight = round4(profile.baseWeight * factor);
  return {
    reportId: obs.reportId,
    observerType: obs.observerType,
    sourceLabel: profile.label,
    observedAt: toIso(obs.observedAt),
    receivedAt: toIso(obs.receivedAt),
    flowLevel: obs.flowLevel,
    baseWeight: profile.baseWeight,
    freshness: round4(factor),
    weight,
    expiresAt: toIso(expiresAt),
    phase,
    positiveMass: round4(weight * score),
    negativeMass: round4(weight * (1 - score)),
    evidenceDigest: obs.details?.evidenceDigest ?? null,
    summary: obs.details?.note ?? obs.details?.summary ?? null,
    details: obs.details,
  };
}

function classify(mass) {
  if (mass.total === 0) return "unknown";
  const ratio = mass.positive / mass.total;
  if (ratio >= RELIABLE) return "reliable";
  if (ratio <= UNRELIABLE) return "unreliable";
  return "conflicting";
}

// 在不引入新事件的前提下，推进到 expiryTimes/封闭边界中的某个时刻重算，
// 找出结论实际翻转的最早时刻（“结论会在何时衰减/改变”）。
function nextChangeAt(active, closures, atMs, currentStatus) {
  const candidates = [];
  for (const obs of active) {
    const expiresAt = obs.observedAt + profileOf(obs.observerType).stalenessMs;
    if (expiresAt > atMs) candidates.push(expiresAt);
  }
  for (const c of closures) {
    if (c.effectiveFrom > atMs) candidates.push(c.effectiveFrom);
    if (c.effectiveTo != null && c.effectiveTo > atMs) candidates.push(c.effectiveTo);
  }
  candidates.sort((a, b) => a - b);
  for (const t of candidates) {
    const next = assessMass(active, t);
    const closed = closures.some((c) => closureActiveAt(c, t));
    const status = closed ? "closed" : classify(next);
    if (status !== currentStatus) return t;
  }
  return null;
}

function assessMass(active, atMs) {
  let positive = 0;
  let negative = 0;
  for (const obs of active) {
    const profile = profileOf(obs.observerType);
    const age = atMs - obs.observedAt;
    if (age < 0 || age >= profile.stalenessMs) continue;
    const factor = 1 - age / profile.stalenessMs;
    const w = profile.baseWeight * factor;
    positive += w * FLOW_SCORE[obs.flowLevel];
    negative += w * (1 - FLOW_SCORE[obs.flowLevel]);
  }
  return { positive, negative, total: positive + negative };
}

export function assessWaterPoint(waterPoint, allObservations, retractions, closures, atMs) {
  const ordered = [...allObservations].sort(evidenceOrder);
  const knownRetractions = retractionsKnownAt(retractions, atMs);

  const liveEvidence = [];
  const retractedEvidence = [];
  const active = [];
  for (const obs of ordered) {
    const item = decorate(obs, atMs);
    const retraction = knownRetractions.get(obs.reportId);
    if (retraction) {
      retractedEvidence.push({
        ...item,
        retraction: {
          retractionId: retraction.retractionId,
          reason: retraction.reason,
          receivedAt: toIso(retraction.receivedAt),
        },
      });
      continue;
    }
    liveEvidence.push(item);
    if (item.phase === "active") active.push(obs);
  }

  const activeClosures = closures.filter((c) => closureActiveAt(c, atMs));
  const mass = assessMass(active, atMs);
  const reliability = mass.total === 0 ? null : round4(mass.positive / mass.total);
  const observationStatus = classify(mass);
  const status = activeClosures.length > 0 ? "closed" : observationStatus;

  // 证据归属按离散语义：strong/usable 支持可补水，trickle/dry 反对。
  // （结论的加权仍使用连续 FLOW_SCORE，归属仅用于正反两栏的展示。）
  const supporting = liveEvidence
    .filter((e) => e.phase === "active" && FLOW_SCORE[e.flowLevel] >= 0.66)
    .sort((a, b) => b.weight - a.weight || evidenceOrder(a, b));
  const opposing = liveEvidence
    .filter((e) => e.phase === "active" && FLOW_SCORE[e.flowLevel] <= 0.35)
    .sort((a, b) => b.weight - a.weight || evidenceOrder(a, b));

  // 当前仍参与加权的证据中，最早到达时效终点的时刻——结论从这一刻起开始衰减。
  const decaysAt = active.length
    ? Math.min(...active.map((o) => o.observedAt + profileOf(o.observerType).stalenessMs))
    : null;

  return {
    waterPointId: waterPoint.waterPointId,
    name: waterPoint.name,
    location: waterPoint.location,
    evaluatedAt: toIso(atMs),
    status,
    observationStatus,
    reliability,
    closedBy: activeClosures.map((c) => ({
      closureId: c.closureId,
      authority: c.authority,
      reason: c.reason,
      effectiveFrom: toIso(c.effectiveFrom),
      effectiveTo: c.effectiveTo == null ? null : toIso(c.effectiveTo),
    })),
    decaysAt: decaysAt == null ? null : toIso(decaysAt),
    nextStatusChangeAt: (() => {
      const t = nextChangeAt(active, closures, atMs, status);
      return t == null ? null : toIso(t);
    })(),
    masses: {
      positive: round4(mass.positive),
      negative: round4(mass.negative),
      total: round4(mass.total),
    },
    supportingEvidence: supporting,
    opposingEvidence: opposing,
    // 全部未撤回证据按确定顺序 (observedAt, reportId) 排列，供审计核对；迟到报告不改变其序。
    evidence: liveEvidence,
    staleEvidence: liveEvidence.filter((e) => e.phase !== "active"),
    retractedEvidence,
  };
}
