// 纯 Node http 的 JSON API，无第三方依赖。
import { createServer } from "node:http";
import { assessWaterPoint } from "../domain/assessment.js";
import { parseInstant, toIso } from "../domain/time.js";
import { ConflictError, NotFoundError } from "../store/event-store.js";

export function createApp(store, clock = () => Date.now()) {
  return createServer(async (req, res) => {
    try {
      await route(req, res, store, clock);
    } catch (err) {
      if (err instanceof SyntaxError) return send(res, 400, { error: "请求体不是合法 JSON" });
      if (err instanceof TypeError) return send(res, 400, { error: err.message });
      if (err instanceof NotFoundError) return send(res, 404, { error: err.message });
      if (err instanceof ConflictError) return send(res, 409, { error: err.message });
      console.error(err);
      send(res, 500, { error: "服务器内部错误" });
    }
  });
}

async function route(req, res, store, clock) {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  const method = req.method;

  if (p === "/health" && method === "GET") {
    return send(res, 200, { ok: true });
  }

  // 水点
  if (p === "/water-points" && method === "POST") {
    const body = await readJson(req);
    const { waterPoint, deduplicated } = await store.registerWaterPoint(body);
    return send(res, deduplicated ? 200 : 201, { data: serializeWaterPoint(waterPoint), meta: { deduplicated } });
  }
  if (p === "/water-points" && method === "GET") {
    return send(res, 200, { data: store.listWaterPoints().map(serializeWaterPoint) });
  }

  let m;
  if ((m = p.match(/^\/water-points\/([^/]+)$/)) && method === "GET") {
    return send(res, 200, { data: serializeWaterPoint(store.getWaterPoint(m[1])) });
  }

  // 单个水点“此刻是否值得依赖”：?at= 缺省为当前时刻（实时查看）。
  if ((m = p.match(/^\/water-points\/([^/]+)\/assessment$/)) && method === "GET") {
    const id = m[1];
    const at = url.searchParams.get("at") ? parseInstant(url.searchParams.get("at"), "at") : clock();
    const result = assessWaterPoint(
      store.getWaterPoint(id),
      store.listObservations(id),
      store.listRetractions(id),
      store.listClosures(id),
      at
    );
    return send(res, 200, { data: result });
  }

  // 原始观测（支持/反对证据的审计视图，按确定顺序）
  if ((m = p.match(/^\/water-points\/([^/]+)\/observations$/)) && method === "POST") {
    const body = await readJson(req);
    const { observation, deduplicated } = await store.recordObservation(body);
    return send(res, deduplicated ? 200 : 201, { data: serializeObservation(observation), meta: { deduplicated } });
  }
  if ((m = p.match(/^\/water-points\/([^/]+)\/observations$/)) && method === "GET") {
    return send(res, 200, { data: store.listObservations(m[1]).map(serializeObservation) });
  }

  // 撤回：只追加说明
  if ((m = p.match(/^\/water-points\/([^/]+)\/retractions$/)) && method === "POST") {
    const body = await readJson(req);
    body.waterPointId = m[1];
    const { retraction, deduplicated } = await store.addRetraction(body);
    return send(res, deduplicated ? 200 : 201, { data: serializeRetraction(retraction), meta: { deduplicated } });
  }
  if ((m = p.match(/^\/water-points\/([^/]+)\/retractions$/)) && method === "GET") {
    return send(res, 200, { data: store.listRetractions(m[1]).map(serializeRetraction) });
  }

  // 官方封闭：独立生效区间
  if ((m = p.match(/^\/water-points\/([^/]+)\/closures$/)) && method === "POST") {
    const body = await readJson(req);
    body.waterPointId = m[1];
    const { closure, deduplicated } = await store.registerClosure(body);
    return send(res, deduplicated ? 200 : 201, { data: serializeClosure(closure), meta: { deduplicated } });
  }
  if ((m = p.match(/^\/water-points\/([^/]+)\/closures$/)) && method === "GET") {
    return send(res, 200, { data: store.listClosures(m[1]).map(serializeClosure) });
  }

  // 路线
  if (p === "/routes" && method === "POST") {
    const body = await readJson(req);
    const { route, deduplicated } = await store.defineRoute(body);
    return send(res, deduplicated ? 200 : 201, { data: route, meta: { deduplicated } });
  }
  if (p === "/routes" && method === "GET") {
    return send(res, 200, { data: store.listRoutes() });
  }
  if ((m = p.match(/^\/routes\/([^/]+)$/)) && method === "GET") {
    return send(res, 200, { data: store.getRoute(m[1]) });
  }

  // 行程推导：输入队伍人数、出发时刻、各路段耗时，返回风险段与安全余量
  if ((m = p.match(/^\/routes\/([^/]+)\/trip-assessments$/)) && method === "POST") {
    const body = await readJson(req);
    const { assessment, deduplicated } = await store.assessTrip(m[1], body);
    return send(res, deduplicated ? 200 : 201, {
      data: assessment.result,
      meta: { assessmentId: assessment.assessmentId, deduplicated },
    });
  }
  if ((m = p.match(/^\/trip-assessments\/([^/]+)$/)) && method === "GET") {
    return send(res, 200, { data: store.getAssessment(m[1]).result });
  }
  if (p === "/trip-assessments" && method === "GET") {
    return send(res, 200, { data: store.listAssessments().map((a) => ({ assessmentId: a.assessmentId, routeId: a.routeId, input: a.input })) });
  }

  return send(res, 404, { error: "未知的接口或方法" });
}

function serializeWaterPoint(wp) {
  return {
    waterPointId: wp.waterPointId,
    name: wp.name,
    location: wp.location,
    ...(wp.details && Object.keys(wp.details).length ? { details: wp.details } : {}),
    ...(wp.createdAt == null ? {} : { createdAt: toIso(wp.createdAt) }),
  };
}

function serializeClosure(c) {
  return { ...c, effectiveFrom: toIso(c.effectiveFrom), effectiveTo: c.effectiveTo == null ? null : toIso(c.effectiveTo), issuedAt: toIso(c.issuedAt) };
}

function serializeObservation(o) {
  return {
    reportId: o.reportId,
    waterPointId: o.waterPointId,
    observerType: o.observerType,
    sourceLabel: o.sourceLabel,
    observedAt: toIso(o.observedAt),
    receivedAt: toIso(o.receivedAt),
    flowLevel: o.flowLevel,
    details: o.details,
  };
}

function serializeRetraction(r) {
  return {
    retractionId: r.retractionId,
    reportId: r.reportId,
    waterPointId: r.waterPointId,
    reason: r.reason,
    receivedAt: toIso(r.receivedAt),
    details: r.details,
  };
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function send(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}
