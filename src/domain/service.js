import { readWaterReport } from "../water-report.js";
import { stableStringify, parseInstant } from "../canonical.js";
import { buildProjection, reduce, reportsFor } from "./projection.js";
import { assessWaterPoint, CONSTANTS_VERSION } from "./assessment.js";
import { planTrip } from "./trip.js";
import { conflict, invalidRequest, notFound } from "../errors.js";

function requireId(value, label) {
  if (typeof value !== "string" || !value.trim()) throw invalidRequest(`${label}不能为空`);
  return value.trim();
}

// 应用服务：所有写操作都先校验、再作为事件追加；读操作只走投影。
// 状态派生函数全部是纯函数，服务自身不缓存任何判断结论。
export function createService(store) {
  let state = buildProjection(store.events);

  function commit(type, payload) {
    const event = store.append(type, payload);
    reduce(state, event);
    return event;
  }

  function registerWaterPoint(input = {}) {
    const waterPointId = requireId(input.waterPointId, "waterPointId");
    const existing = state.waterPoints.get(waterPointId);
    if (existing && !existing.stub) throw conflict(`水点已注册: ${waterPointId}`);
    if (input.name !== undefined && typeof input.name !== "string") throw invalidRequest("name 必须是字符串");
    if (input.ttlHours !== undefined && (typeof input.ttlHours !== "number" || input.ttlHours <= 0)) {
      throw invalidRequest("ttlHours 必须是正数（小时）");
    }
    let location = input.location ?? null;
    if (location != null && (typeof location !== "object" || Array.isArray(location))) {
      throw invalidRequest("location 必须是坐标对象或 null");
    }
    const base = ["waterPointId", "name", "location", "ttlHours"];
    const details =
      input.details && typeof input.details === "object" && !Array.isArray(input.details)
        ? input.details
        : Object.fromEntries(Object.entries(input).filter(([key]) => !base.includes(key)));

    const payload = {
      waterPointId,
      name: input.name ?? null,
      location,
      ttlHours: input.ttlHours ?? null,
      details,
    };
    commit("water-point-registered", payload);
    return { waterPointId, duplicated: false };
  }

  // 入库观测报告。reportId 是重传去重键：
  // - 内容一致：幂等返回，不追加事件、不动任何顺序
  // - 内容不一致：拒绝（409），报告身份不可复用
  function ingestReport(body) {
    let parsed;
    try {
      parsed = readWaterReport(body);
    } catch (err) {
      throw invalidRequest(err.message);
    }
    parseInstant(parsed.observedAt, "observedAt");
    parseInstant(parsed.receivedAt, "receivedAt");

    const payload = {
      reportId: parsed.reportId,
      waterPointId: parsed.waterPointId,
      observerType: parsed.observerType,
      observedAt: parsed.observedAt,
      receivedAt: parsed.receivedAt,
      flowLevel: parsed.flowLevel,
      // 位置/证据摘要/备注及一切未知属性随 details 原样落盘
      details: parsed.details ?? {},
    };
    const canonical = stableStringify(payload);

    const existing = state.reports.get(payload.reportId);
    if (existing) {
      const existingCanonical = stableStringify({
        reportId: existing.reportId,
        waterPointId: existing.waterPointId,
        observerType: existing.observerType,
        observedAt: existing.observedAt,
        receivedAt: existing.receivedAt,
        flowLevel: existing.flowLevel,
        details: existing.details ?? {},
      });
      if (existingCanonical === canonical) {
        return { reportId: payload.reportId, duplicated: true, ingestSeq: existing.ingestSeq };
      }
      throw conflict(`reportId ${payload.reportId} 已存在但内容不同；更正请走撤回追加，不能覆盖`);
    }

    const event = commit("report-received", payload);
    return { reportId: payload.reportId, duplicated: false, ingestSeq: event.seq };
  }

  // 撤回误报：只追加一条说明，原观测内容与顺序永不改变
  function retractReport(input = {}) {
    const reportId = requireId(input.reportId, "reportId");
    if (!state.reports.has(reportId)) throw notFound(`观测报告不存在: ${reportId}`);
    const reason = requireId(input.reason, "reason");
    if (input.source !== undefined && typeof input.source !== "string") throw invalidRequest("source 必须是字符串");
    if (input.note !== undefined && typeof input.note !== "string") throw invalidRequest("note 必须是字符串");

    const payload = {
      reportId,
      reason,
      source: input.source ?? null,
      note: input.note ?? null,
    };
    const event = commit("report-retracted", payload);
    const retractions = state.retractionsByReport.get(reportId);
    return { reportId, retractionCount: retractions.length, seq: event.seq };
  }

  function issueClosure(input = {}) {
    const closureId = requireId(input.closureId, "closureId");
    const waterPointId = requireId(input.waterPointId, "waterPointId");
    if (state.closures.has(closureId)) throw conflict(`封闭通告已存在: ${closureId}`);
    const startAt = parseInstant(input.startAt ?? null, "startAt");
    let endAt = null;
    if (input.endAt != null) {
      endAt = parseInstant(input.endAt, "endAt");
      if (endAt <= startAt) throw invalidRequest("endAt 必须晚于 startAt（不传 endAt 表示无限期封闭）");
    }
    const reason = requireId(input.reason, "reason");
    if (input.issuedBy !== undefined && typeof input.issuedBy !== "string") throw invalidRequest("issuedBy 必须是字符串");

    const payload = {
      closureId,
      waterPointId,
      startAt: input.startAt,
      endAt: input.endAt ?? null,
      reason,
      issuedBy: input.issuedBy ?? null,
    };
    commit("closure-issued", payload);
    return { closureId };
  }

  function assess(waterPointId, asOf) {
    if (!state.waterPoints.has(waterPointId)) throw notFound(`水点不存在: ${waterPointId}`);
    const atMs = asOf == null ? Date.now() : parseInstant(asOf, "asOf");
    const assessment = assessWaterPoint(state, waterPointId, atMs);
    return { ...assessment, meta: { seq: store.seq, stateHash: store.stateHash(), constantsVersion: CONSTANTS_VERSION } };
  }

  function listWaterPoints(asOf) {
    const atMs = asOf == null ? Date.now() : parseInstant(asOf, "asOf");
    const items = [...state.waterPoints.keys()]
      .sort()
      .map((id) => {
        const a = assessWaterPoint(state, id, atMs);
        return {
          waterPointId: id,
          name: a.name,
          status: a.status,
          conclusionExpiresAt: a.conclusionExpiresAt,
          reportCount: reportsFor(state, id).length,
        };
      });
    return { asOf: new Date(atMs).toISOString(), items, meta: { seq: store.seq, stateHash: store.stateHash() } };
  }

  function plan(input) {
    const result = planTrip(state, input, CONSTANTS_VERSION);
    return { ...result, meta: { seq: store.seq, stateHash: store.stateHash(), constantsVersion: CONSTANTS_VERSION } };
  }

  function meta() {
    return {
      seq: store.seq,
      stateHash: store.stateHash(),
      constantsVersion: CONSTANTS_VERSION,
      counts: {
        waterPoints: state.waterPoints.size,
        reports: state.reports.size,
        retractions: [...state.retractionsByReport.values()].reduce((s, list) => s + list.length, 0),
        closures: state.closures.size,
      },
    };
  }

  return { registerWaterPoint, ingestReport, retractReport, issueClosure, assess, listWaterPoints, plan, meta };
}
