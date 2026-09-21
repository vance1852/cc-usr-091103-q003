import { parseInstant, round3 } from "../canonical.js";
import { assessWaterPoint } from "./assessment.js";
import { invalidRequest } from "../errors.js";

// 行程规划口径（与 CONSTANTS_VERSION 一起返回，推导依据可复核）
export const PLAN_DEFAULTS = {
  perPersonLitersPerHour: 0.5,
  safetyFactor: 1.25,
  // 细流/争议水点在“乐观估计”中按一半补水能力计；安全口径里一律视为不能保证
  marginalRefillFactor: 0.5,
};

function riskFromAssessment(assessment) {
  if (assessment.status === "closed") {
    return {
      code: "closed",
      reason: `官方封闭生效中（${assessment.closure.startAt} 起）：${assessment.closure.reason}`,
      closureId: assessment.closure.closureId,
      evidenceReportIds: [],
    };
  }
  const opposing = assessment.evidence.opposing.filter((e) => e.weight > 0);
  const caution = assessment.evidence.caution.filter((e) => e.weight > 0);
  switch (assessment.verdict.status) {
    case "unreliable":
      return {
        code: "dry",
        reason: assessment.verdict.reason,
        evidenceReportIds: (opposing.length ? opposing : assessment.evidence.opposing).map((e) => e.reportId),
      };
    case "marginal":
      return {
        code: "trickle",
        reason: assessment.verdict.reason,
        evidenceReportIds: caution.map((e) => e.reportId),
      };
    case "contested":
      return {
        code: "contested",
        reason: assessment.verdict.reason,
        evidenceReportIds: assessment.verdict.decisiveReportIds,
      };
    case "unknown":
      return {
        code: "unknown_or_stale",
        reason: assessment.verdict.reason,
        evidenceReportIds: assessment.evidence.opposing
          .concat(assessment.evidence.caution)
          .concat(assessment.evidence.supporting)
          .slice(0, 3)
          .map((e) => e.reportId),
      };
    default:
      return null;
  }
}

// 纯函数：给定投影与行程输入，输出风险段与安全携带量。
// 不读时钟——startAt 由调用方给出，事件日志不变则结果不变。
export function planTrip(state, input, constantsVersion) {
  if (!input || typeof input !== "object") throw invalidRequest("行程参数必须是对象");
  const partySize = input.partySize;
  if (typeof partySize !== "number" || !Number.isFinite(partySize) || partySize <= 0) {
    throw invalidRequest("partySize 必须是正数");
  }
  if (!Array.isArray(input.legs) || input.legs.length === 0) throw invalidRequest("legs 至少包含一个路段");
  const startAt = parseInstant(input.startAt ?? null, "startAt");

  const rate = input.perPersonLitersPerHour ?? PLAN_DEFAULTS.perPersonLitersPerHour;
  const safetyFactor = input.safetyFactor ?? PLAN_DEFAULTS.safetyFactor;
  const marginalRefillFactor = input.marginalRefillFactor ?? PLAN_DEFAULTS.marginalRefillFactor;
  for (const [name, v] of [
    ["perPersonLitersPerHour", rate],
    ["safetyFactor", safetyFactor],
    ["marginalRefillFactor", marginalRefillFactor],
  ]) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw invalidRequest(`${name} 必须是非负数`);
  }
  if (safetyFactor < 1) throw invalidRequest("safetyFactor 不能小于 1");
  const capacityPerPerson = input.perPersonCarryCapacityLiters ?? null;
  if (capacityPerPerson !== null && (typeof capacityPerPerson !== "number" || capacityPerPerson <= 0)) {
    throw invalidRequest("perPersonCarryCapacityLiters 必须是正数或省略");
  }

  const legs = [];
  let cursor = startAt;
  for (let i = 0; i < input.legs.length; i += 1) {
    const leg = input.legs[i];
    if (!leg || typeof leg !== "object") throw invalidRequest(`第 ${i + 1} 个路段格式不正确`);
    if (typeof leg.toWaterPointId !== "string" || !leg.toWaterPointId.trim()) {
      throw invalidRequest(`第 ${i + 1} 个路段缺少 toWaterPointId`);
    }
    const durationHours = leg.durationHours;
    if (typeof durationHours !== "number" || !Number.isFinite(durationHours) || durationHours < 0) {
      throw invalidRequest(`第 ${i + 1} 个路段 durationHours 必须是非负数`);
    }
    cursor += durationHours * 3_600_000;
    const assessment = assessWaterPoint(state, leg.toWaterPointId, cursor);
    if (assessment === null) throw invalidRequest(`路段终点水点不存在: ${leg.toWaterPointId}`);

    const demand = round3(partySize * durationHours * rate);
    const safeDemand = round3(demand * safetyFactor);
    const refillClass =
      assessment.status === "reliable" ? "full" : ["marginal", "contested"].includes(assessment.status) ? "partial" : "none";
    const risk = refillClass === "full" ? null : riskFromAssessment(assessment);

    legs.push({
      index: i,
      toWaterPointId: leg.toWaterPointId,
      durationHours,
      arrivalAt: new Date(cursor).toISOString(),
      demandLiters: demand,
      safeDemandLiters: safeDemand,
      arrivalStatus: assessment.status,
      conclusionExpiresAt: assessment.conclusionExpiresAt,
      refillClass, // full=可补满 | partial=不能保证 | none=不可补
      risk,
      basis: {
        scores: assessment.scores,
        closureId: assessment.closure?.closureId ?? null,
        decisiveReportIds: assessment.verdict.decisiveReportIds,
      },
    });
  }

  // 以“可补满”的水点切段：两个可靠补水点之间的全部消耗必须从上一个可靠点背出来
  const segments = [];
  let current = { fromLegIndex: 0, legIndexes: [], totalDemand: 0, totalSafeDemand: 0 };
  for (const leg of legs) {
    current.legIndexes.push(leg.index);
    current.totalDemand = round3(current.totalDemand + leg.demandLiters);
    current.totalSafeDemand = round3(current.totalSafeDemand + leg.safeDemandLiters);
    if (leg.refillClass === "full") {
      current.toLegIndex = leg.index;
      current.refillWaterPointId = leg.toWaterPointId;
      current.endsWithReliableRefill = true;
      segments.push(current);
      current = { fromLegIndex: leg.index + 1, legIndexes: [], totalDemand: 0, totalSafeDemand: 0 };
    }
  }
  if (current.legIndexes.length > 0) {
    current.toLegIndex = current.legIndexes[current.legIndexes.length - 1];
    current.endsWithReliableRefill = false;
    segments.push(current);
  }

  // 乐观估计：从段末倒推，假设细流/争议点能补上后续需求的 marginalRefillFactor；
  // 安全口径完全不计这笔钱。
  function optimisticCarry(legIndexes) {
    let need = 0;
    for (let k = legIndexes.length - 1; k >= 0; k -= 1) {
      const leg = legs[legIndexes[k]];
      if (leg.refillClass === "partial") need = leg.demandLiters + need * (1 - marginalRefillFactor);
      else need = leg.demandLiters + need; // none（末端不可补同样按 none 处理）
    }
    return round3(need);
  }

  const shapedSegments = segments.map((seg, i) => {
    const carryCapacity = capacityPerPerson === null ? null : round3(capacityPerPerson * partySize);
    const optimistic = optimisticCarry(seg.legIndexes);
    return {
      segmentIndex: i,
      fromLegIndex: seg.fromLegIndex,
      toLegIndex: seg.toLegIndex,
      legIndexes: seg.legIndexes,
      refillWaterPointId: seg.refillWaterPointId ?? null,
      endsWithReliableRefill: seg.endsWithReliableRefill,
      demandLiters: seg.totalDemand,
      safetyMarginLiters: round3(seg.totalSafeDemand - seg.totalDemand),
      // 安全口径：段首必须背出的水量（含安全余量，细流/争议一律不计）
      recommendedCarryLiters: seg.totalSafeDemand,
      // 乐观口径：若细流/争议点真能补一半时，理论上可以少背多少（仅供权衡，不作保证）
      optimisticCarryLiters: optimistic,
      carryCapacityLiters: carryCapacity,
      exceedsCarryCapacity: carryCapacity === null ? false : seg.totalSafeDemand > carryCapacity,
      expectedRefillNote: seg.endsWithReliableRefill
        ? null
        : "该段内没有可保证补满的水点，末端之后仍需自行背水；细流/争议点的 50% 估计不计入安全口径",
    };
  });

  const riskLegs = legs.filter((l) => l.risk);
  return {
    startAt: input.startAt,
    partySize,
    assumptions: {
      perPersonLitersPerHour: rate,
      safetyFactor,
      marginalRefillFactor,
      perPersonCarryCapacityLiters: capacityPerPerson,
      constantsVersion,
    },
    legs,
    segments: shapedSegments,
    riskLegs: riskLegs.map((l) => ({ index: l.index, toWaterPointId: l.toWaterPointId, arrivalAt: l.arrivalAt, ...l.risk })),
    summary: {
      totalDemandLiters: round3(legs.reduce((s, l) => s + l.demandLiters, 0)),
      totalSafetyMarginLiters: round3(legs.reduce((s, l) => s + l.safeDemandLiters - l.demandLiters, 0)),
      maxRecommendedCarryLiters: Math.max(0, ...shapedSegments.map((s) => s.recommendedCarryLiters)),
      riskLegCount: riskLegs.length,
      openEndedSegment: shapedSegments.some((s) => !s.endsWithReliableRefill),
    },
  };
}
