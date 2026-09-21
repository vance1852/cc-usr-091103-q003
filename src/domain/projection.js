import { parseInstant } from "../canonical.js";

// 事件重放后的内存投影。所有判定只读这个结构，不直接读日志。
export function createState() {
  return {
    waterPoints: new Map(), // waterPointId -> {waterPointId, name, location, ttlHours, stub}
    reports: new Map(), // reportId -> 报告（含 details）+ ingestSeq
    reportsByPoint: new Map(), // waterPointId -> reportId[]
    retractionsByReport: new Map(), // reportId -> 撤回说明[]（只追加）
    closures: new Map(), // closureId -> 封闭区间 payload
  };
}

export function reduce(state, event) {
  const { type, payload, seq, recordedAt } = event;
  switch (type) {
    case "water-point-registered": {
      const existing = state.waterPoints.get(payload.waterPointId);
      if (!existing) {
        state.waterPoints.set(payload.waterPointId, { stub: false, ...payload });
      } else if (existing.stub) {
        // 报告先到、注册后补：只允许把占位点补全，不允许改写已有资料
        state.waterPoints.set(payload.waterPointId, { stub: false, ...payload });
      }
      // 重复注册在 API 层已拦截；重放时保留首次事实，不抛错
      return;
    }
    case "report-received": {
      if (state.reports.has(payload.reportId)) return;
      if (!state.waterPoints.has(payload.waterPointId)) {
        state.waterPoints.set(payload.waterPointId, {
          waterPointId: payload.waterPointId,
          name: undefined,
          location: null,
          ttlHours: undefined,
          stub: true,
        });
      }
      state.reports.set(payload.reportId, { ...payload, ingestSeq: seq, ingestRecordedAt: recordedAt });
      if (!state.reportsByPoint.has(payload.waterPointId)) state.reportsByPoint.set(payload.waterPointId, []);
      state.reportsByPoint.get(payload.waterPointId).push(payload.reportId);
      return;
    }
    case "report-retracted": {
      const list = state.retractionsByReport.get(payload.reportId) ?? [];
      list.push({ ...payload, recordedAt });
      state.retractionsByReport.set(payload.reportId, list);
      return;
    }
    case "closure-issued": {
      if (!state.closures.has(payload.closureId)) state.closures.set(payload.closureId, payload);
      return;
    }
    default:
      throw new Error(`未知事件类型: ${type}`);
  }
}

export function buildProjection(events) {
  const state = createState();
  for (const event of events) reduce(state, event);
  return state;
}

// 证据的确定顺序：观测时刻升序，再以 reportId 字典序兜底。
// 与收到时刻（receivedAt）、入库序号（ingestSeq）无关，因此迟到或重传不会改变顺序。
export function reportsFor(state, waterPointId) {
  const ids = state.reportsByPoint.get(waterPointId) ?? [];
  return ids
    .map((id) => state.reports.get(id))
    .sort((a, b) => {
      const ta = parseInstant(a.observedAt, "observedAt");
      const tb = parseInstant(b.observedAt, "observedAt");
      return ta - tb || (a.reportId < b.reportId ? -1 : a.reportId > b.reportId ? 1 : 0);
    });
}

export function closuresFor(state, waterPointId) {
  return [...state.closures.values()]
    .filter((c) => c.waterPointId === waterPointId)
    .sort((a, b) => parseInstant(a.startAt) - parseInstant(b.startAt) || (a.closureId < b.closureId ? -1 : 1));
}
