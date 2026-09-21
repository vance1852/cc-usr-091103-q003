// 行程推导：沿路线时间线，在“抵达时刻”评估每个水点，
// 输出补水缺口段与应携带的安全余量。
// 规划采取保守口径：只有 status=reliable 才视作可放心补水；
// conflicting（冲突）只可作不确定的应急水源，不计入确定性补给。
import { assessWaterPoint } from "./assessment.js";
import { toIso } from "./time.js";

const round2 = (n) => Math.round(n * 100) / 100;

export function planTrip({ route, waterPoints, observationsByPoint, retractionsByPoint, closuresByPoint, itinerary, assessmentId = null }) {
  const legByKey = new Map(route.legs.map((l) => [`${l.fromPointId}->${l.toPointId}`, l]));

  // 1) 时间线：累计各路段耗时，求每个节点的计划抵达时刻。
  let cursor = itinerary.startAt;
  const timeline = [{ pointId: route.order[0], arriveAt: cursor, leg: null }];
  for (let i = 1; i < route.order.length; i++) {
    const leg = legByKey.get(`${route.order[i - 1]}->${route.order[i]}`);
    cursor += itinerary.legMinutes[leg.legId] * 60_000;
    timeline.push({ pointId: route.order[i], arriveAt: cursor, leg });
  }

  // 2) 每个节点在抵达时刻的水点结论。
  const pointResults = timeline.map((node) => {
    const def = route.points.find((p) => p.pointId === node.pointId);
    if (!def.waterPointId) {
      return { ...node, routePoint: def, waterPointId: null, assessment: null };
    }
    const wp = waterPoints.get(def.waterPointId);
    if (!wp) {
      // 路线引用了未注册水点：不使规划崩溃，标记为 unregistered 进入风险说明。
      return { ...node, routePoint: def, waterPointId: def.waterPointId, assessment: null, missing: true };
    }
    const assessment = assessWaterPoint(
      wp,
      observationsByPoint.get(def.waterPointId) ?? [],
      retractionsByPoint.get(def.waterPointId) ?? [],
      closuresByPoint.get(def.waterPointId) ?? [],
      node.arriveAt
    );
    return { ...node, routePoint: def, waterPointId: def.waterPointId, assessment };
  });

  // 3) 缺口分段：从起点开始，走到下一个 reliable 水点为一段；
  //    段内所有非 reliable 水点都必须带说明（断流/封闭/证据过期/冲突/无证据）。
  const ratePerMinutePerPerson = itinerary.litersPerPersonHour / 60;
  const segments = [];
  let startIdx = 0;
  for (let i = 0; i <= pointResults.length; i++) {
    const reachedReliable = i > startIdx && pointResults[i]?.assessment?.status === "reliable";
    const endOfRoute = i === pointResults.length;
    if (!reachedReliable && !endOfRoute) continue;
    // 终点本身已是上一段的可靠目的地：不再生成零长度尾段。
    if (endOfRoute && startIdx === pointResults.length - 1) break;

    const endIdx = endOfRoute ? pointResults.length - 1 : i;
    const startNode = pointResults[startIdx];
    const endNode = pointResults[endIdx];
    const durationMin = (endNode.arriveAt - startNode.arriveAt) / 60_000;
    const baseNeed = round2(durationMin * ratePerMinutePerPerson * itinerary.partySize);
    const reserve = round2(baseNeed * itinerary.reserveRatio);
    const carryRequired = round2(baseNeed + reserve);

    // 段内水点：起点本身若绑定水点且不可靠（出发地不能指望补水）也要列出；
    // 终点可靠时其状态同样展示，便于使用者核对“为什么这一段到此为止”。
    const members = pointResults.slice(startIdx, endIdx + 1);
    const lastOffset = members.length - 1;
    const passed = members.map((r, offset) => {
      if (!r.waterPointId) return null;
      if (r.missing) {
        return { pointId: r.pointId, waterPointId: r.waterPointId, arriveAt: toIso(r.arriveAt), status: "unregistered", note: "路线引用了未注册水点" };
      }
      const a = r.assessment;
      return {
        pointId: r.pointId,
        waterPointId: r.waterPointId,
        name: a.name,
        arriveAt: toIso(r.arriveAt),
        role: offset === 0 ? "segment-start" : offset === lastOffset ? "segment-end" : "within",
        status: a.status,
        reliability: a.reliability,
        decaysAt: a.decaysAt,
        closedBy: a.closedBy,
        supportingCount: a.supportingEvidence.length,
        opposingCount: a.opposingEvidence.length,
        reason: statusReason(a),
      };
    }).filter(Boolean);

    const destReliable = !endOfRoute && endNode.assessment?.status === "reliable";
    let risk = "ok";
    if (!destReliable) risk = "critical";
    else if (durationMin >= itinerary.longGapWarnMinutes) risk = "caution";
    if (risk !== "critical" && passed.some((p) => p.status === "unreliable" || p.status === "closed")) {
      risk = "caution";
    }

    segments.push({
      fromPointId: startNode.pointId,
      toPointId: endNode.pointId,
      toWaterPointId: endNode.waterPointId,
      destinationReliable: destReliable,
      durationMinutes: round2(durationMin),
      waterNeedLiters: baseNeed,
      reserveLiters: reserve,
      carryRequiredLiters: carryRequired,
      risk,
      waterPointsWithin: passed,
    });

    if (!endOfRoute) startIdx = i;
    if (endOfRoute) break;
  }

  // 4) 汇总：任意相邻可靠水源间（或路线首尾）的携水量要求；全程峰值即建议携带能力。
  const maxCarry = Math.max(...segments.map((s) => s.carryRequiredLiters), 0);
  const riskSegments = segments.filter((s) => s.risk !== "ok");

  return {
    assessmentId,
    routeId: route.routeId,
    generatedFrom: {
      partySize: itinerary.partySize,
      startAt: toIso(itinerary.startAt),
      litersPerPersonHour: itinerary.litersPerPersonHour,
      reserveRatio: itinerary.reserveRatio,
      longGapWarnMinutes: itinerary.longGapWarnMinutes,
      legMinutes: itinerary.legMinutes,
    },
    timeline: pointResults.map((r) => ({
      pointId: r.pointId,
      waterPointId: r.waterPointId,
      arriveAt: toIso(r.arriveAt),
      status: r.assessment?.status ?? (r.waterPointId ? "unregistered" : "no-water-point"),
      reliability: r.assessment?.reliability ?? null,
    })),
    segments,
    summary: {
      totalDurationMinutes: round2((pointResults[pointResults.length - 1].arriveAt - pointResults[0].arriveAt) / 60_000),
      maxCarryRequiredLiters: round2(maxCarry),
      riskSegmentCount: riskSegments.length,
      criticalSegmentCount: segments.filter((s) => s.risk === "critical").length,
    },
    riskSegments,
  };
}

function statusReason(a) {
  switch (a.status) {
    case "closed":
      return `官方封闭中：${a.closedBy.map((c) => `${c.authority}（${c.reason}）`).join("；")}`;
    case "unreliable":
      return a.masses.total === 0 ? "没有有效的在期观测" : "近期证据以断流/细流为主";
    case "conflicting":
      return "来源证据相互冲突，保守规划下不视作可靠补水点";
    case "unknown":
      return "缺少在期证据，最新证据已过期或不存在";
    case "reliable":
      return "在期证据支持抵达时可补水";
    default:
      return null;
  }
}
