// 穿越路线：有序节点（可绑定水点）与连接路段（基准耗时，可被行程输入覆盖）。
import { parseInstant } from "./time.js";

export function defineRoute(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("路线必须是对象");
  }
  const { routeId, name, points, legs } = input;
  if (typeof routeId !== "string" || !routeId.trim()) throw new TypeError("routeId 不完整");
  if (typeof name !== "string" || !name.trim()) throw new TypeError("路线名称不完整");
  if (!Array.isArray(points) || points.length < 2) throw new TypeError("路线至少需要两个节点");
  if (!Array.isArray(legs) || legs.length < 1) throw new TypeError("路线至少需要一个路段");

  const normPoints = [];
  const pointIds = new Set();
  for (const p of points) {
    if (!p || typeof p !== "object") throw new TypeError("路线节点必须是对象");
    if (typeof p.pointId !== "string" || !p.pointId.trim()) throw new TypeError("pointId 不完整");
    if (pointIds.has(p.pointId)) throw new TypeError(`路线节点重复: ${p.pointId}`);
    pointIds.add(p.pointId);
    normPoints.push({
      pointId: p.pointId,
      name: typeof p.name === "string" && p.name.trim() ? p.name : p.pointId,
      waterPointId: p.waterPointId == null ? null : String(p.waterPointId),
    });
  }

  const normLegs = [];
  const legIds = new Set();
  const outgoing = new Map();
  const incoming = new Map();
  for (const leg of legs) {
    if (!leg || typeof leg !== "object") throw new TypeError("路段必须是对象");
    if (typeof leg.legId !== "string" || !leg.legId.trim()) throw new TypeError("legId 不完整");
    if (legIds.has(leg.legId)) throw new TypeError(`路段重复: ${leg.legId}`);
    legIds.add(leg.legId);
    if (!pointIds.has(leg.fromPointId) || !pointIds.has(leg.toPointId)) {
      throw new TypeError(`路段 ${leg.legId} 引用了不存在的节点`);
    }
    const duration = Number(leg.durationMinutes);
    if (!Number.isFinite(duration) || duration <= 0) throw new TypeError(`路段 ${leg.legId} 耗时必须为正数`);
    normLegs.push({ legId: leg.legId, fromPointId: leg.fromPointId, toPointId: leg.toPointId, durationMinutes: duration });
    outgoing.set(leg.fromPointId, leg.toPointId);
    incoming.set(leg.toPointId, leg.fromPointId);
  }

  // 必须是一条线性链：恰有一个起点（无入边）、一个终点（无出边），其余一进一出。
  const starts = normPoints.filter((p) => !incoming.has(p.pointId));
  const ends = normPoints.filter((p) => !outgoing.has(p.pointId));
  if (starts.length !== 1 || ends.length !== 1) throw new TypeError("路线必须是单一线性链（一个起点、一个终点）");
  const ordered = [starts[0]];
  while (ordered.length < normPoints.length) {
    const next = outgoing.get(ordered[ordered.length - 1].pointId);
    if (!next || ordered.some((p) => p.pointId === next)) throw new TypeError("路线存在断裂或环路");
    ordered.push(normPoints.find((p) => p.pointId === next));
  }

  return { routeId, name, points: normPoints, legs: normLegs, order: ordered.map((p) => p.pointId) };
}

export function defineItineraryInput(input, route) {
  if (!input || typeof input !== "object") throw new TypeError("行程输入必须是对象");
  const partySize = Number(input.partySize);
  if (!Number.isInteger(partySize) || partySize < 1) throw new TypeError("队伍人数必须是不小于 1 的整数");
  const startAt = parseInstant(input.startAt, "startAt");

  const rate = input.litersPerPersonHour == null ? 0.5 : Number(input.litersPerPersonHour);
  if (!Number.isFinite(rate) || rate <= 0) throw new TypeError("人均每小时耗水量必须为正数");
  const reserveRatio = input.reserveRatio == null ? 0.25 : Number(input.reserveRatio);
  if (!Number.isFinite(reserveRatio) || reserveRatio < 0) throw new TypeError("安全余量比例不能为负");
  const longGapWarnMinutes = input.longGapWarnMinutes == null ? 360 : Number(input.longGapWarnMinutes);
  if (!Number.isFinite(longGapWarnMinutes) || longGapWarnMinutes <= 0) throw new TypeError("长缺口告警阈值必须为正数");

  // 各路段耗时：以路线基准耗时为默认，允许按 legId 覆盖（驴友实际节奏）。
  const overrides = input.legDurations && typeof input.legDurations === "object" ? input.legDurations : {};
  const legMinutes = {};
  for (const leg of route.legs) {
    const v = overrides[leg.legId];
    const minutes = v == null ? leg.durationMinutes : Number(v);
    if (!Number.isFinite(minutes) || minutes <= 0) throw new TypeError(`路段 ${leg.legId} 耗时必须为正数`);
    legMinutes[leg.legId] = minutes;
  }

  return {
    partySize,
    startAt,
    litersPerPersonHour: rate,
    reserveRatio,
    longGapWarnMinutes,
    legMinutes,
  };
}
