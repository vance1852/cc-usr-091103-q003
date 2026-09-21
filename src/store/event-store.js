// 事件存储：只追加 JSONL 日志（每行 fsync）+ 周期快照 + 启动重放。
// 关键性质：
//  - 任何变更都是不可变事件；撤回/封闭都不修改既有事件内容；
//  - 业务幂等键（reportId/closureId/retractionId/routeId/waterPointId/assessmentId）
//    使相同重传不产生新事件；内容不一致的重传报冲突，绝不静默覆盖；
//  - 事件顺序只由日志行序决定，而证据的“确定顺序”由领域层按
//    (observedAt, reportId) 给出——因此迟到/重放都不会改变证据排序；
//  - 结论不依赖服务器时钟：事件里的业务时刻全部来自请求负载，重放结果一致。
import { open, mkdir, readFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { defineWaterPoint } from "../domain/waterpoint.js";
import { ingestObservation, defineRetraction } from "../domain/observation.js";
import { defineClosure } from "../domain/closure.js";
import { defineRoute, defineItineraryInput } from "../domain/route.js";
import { planTrip } from "../domain/planner.js";

const LOG_FILE = "events.log";
const SNAPSHOT_FILE = "snapshot.json";
const SNAPSHOT_EVERY = 50;

export class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConflictError";
    this.statusCode = 409;
  }
}
export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "NotFoundError";
    this.statusCode = 404;
  }
}

// 稳定序列化：键排序，保证“同一负载”在任何进程里逐字节一致（幂等比对/ID 派生）。
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

function freshState() {
  return {
    waterPoints: new Map(),       // waterPointId -> 水点
    reports: new Map(),           // reportId -> 观测（含 waterPointId）
    observations: new Map(),      // waterPointId -> [观测]
    retractions: new Map(),       // waterPointId -> [撤回]
    retractionIds: new Map(),     // retractionId -> 撤回
    closures: new Map(),          // waterPointId -> [封闭]
    closureIds: new Map(),        // closureId -> 封闭
    routes: new Map(),            // routeId -> 路线
    assessments: new Map(),       // assessmentId -> {routeId, input, result}
  };
}

export class EventStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.state = freshState();
    this.seq = 0;
    this.#writeChain = Promise.resolve();
  }

  #writeChain;
  #fh;

  async recover() {
    await mkdir(this.dataDir, { recursive: true });
    let snap = null;
    const snapPath = join(this.dataDir, SNAPSHOT_FILE);
    if (existsSync(snapPath)) {
      snap = JSON.parse(await readFile(snapPath, "utf8"));
      this.seq = snap.lastSeq;
      this.state = deserializeState(snap.state);
    }
    const logPath = join(this.dataDir, LOG_FILE);
    if (existsSync(logPath)) {
      const text = await readFile(logPath, "utf8");
      // 事件 JSON 不含字面换行（字符串内换行被 JSON.stringify 转义），可安全按行切分。
      const rawLines = text.split("\n");
      const offsets = [0];
      for (const ln of rawLines) offsets.push(offsets[offsets.length - 1] + ln.length + 1);

      let validBytes = offsets[0];
      for (let i = 0; i < rawLines.length; i++) {
        const line = rawLines[i];
        if (!line.trim()) { validBytes = offsets[i + 1] ?? text.length; continue; }
        let event;
        try {
          event = JSON.parse(line);
        } catch (cause) {
          // 仅允许日志末尾存在一行“未确认残行”（fsync 前崩溃，调用方从未得到成功响应）。
          const restIsBlank = rawLines.slice(i + 1).every((l) => !l.trim());
          if (!restIsBlank) {
            throw new Error(`事件日志第 ${i + 1} 行损坏（非末行），拒绝启动以避免证据错乱: ${cause.message}`);
          }
          const fhTrunc = await open(logPath, "r+");
          await fhTrunc.truncate(validBytes);
          await fhTrunc.sync();
          await fhTrunc.close();
          break;
        }
        if (event.seq <= this.seq) { validBytes = offsets[i + 1] ?? text.length; continue; } // 快照已覆盖
        this.apply(event);
        this.seq = event.seq;
        validBytes = offsets[i + 1] ?? text.length;
      }
    }
    this.#fh = await open(logPath, "a");
  }

  // 串行化所有写：同一时刻只有一个追加在进行。
  #enqueue(fn) {
    const run = this.#writeChain.then(fn, fn);
    // 不让链上的拒绝污染后续任务
    this.#writeChain = run.then(() => {}, () => {});
    return run;
  }

  async #append(type, payload, idempotency) {
    return this.#enqueue(async () => {
      if (idempotency) {
        const { key, index, kind } = idempotency;
        const existing = this.state[index]?.get?.(key);
        if (existing !== undefined) {
          if (stableStringify(existing) === stableStringify(payload)) {
            return { deduplicated: true, existing, event: null };
          }
          throw new ConflictError(`${kind}标识 ${key} 已存在且负载不一致；冲突信息不得覆盖，请使用新标识或追加撤回说明`);
        }
      }
      const seq = this.seq + 1;
      const event = { seq, type, recordedAt: Date.now(), payload };
      await this.#fh.write(stableStringify(event) + "\n");
      await this.#fh.sync();
      this.apply(event);
      this.seq = seq;
      if (seq % SNAPSHOT_EVERY === 0) await this.#snapshot(seq);
      return { deduplicated: false, existing: null, event };
    });
  }

  async #snapshot(seq) {
    const snap = { lastSeq: seq, takenAt: new Date().toISOString(), state: serializeState(this.state) };
    const tmp = join(this.dataDir, `.${SNAPSHOT_FILE}.${process.pid}.${seq}.tmp`);
    const h = await open(tmp, "w");
    await h.write(stableStringify(snap));
    await h.sync();
    await h.close();
    await rename(tmp, join(this.dataDir, SNAPSHOT_FILE));
  }

  apply(event) {
    const { type, payload } = event;
    switch (type) {
      case "water-point-registered": {
        const wp = payload;
        this.state.waterPoints.set(wp.waterPointId, wp);
        if (!this.state.observations.has(wp.waterPointId)) this.state.observations.set(wp.waterPointId, []);
        if (!this.state.retractions.has(wp.waterPointId)) this.state.retractions.set(wp.waterPointId, []);
        if (!this.state.closures.has(wp.waterPointId)) this.state.closures.set(wp.waterPointId, []);
        break;
      }
      case "observation-recorded": {
        const obs = payload;
        this.state.reports.set(obs.reportId, obs);
        this.state.observations.get(obs.waterPointId).push(obs);
        break;
      }
      case "retraction-added": {
        const r = payload;
        this.state.retractionIds.set(r.retractionId, r);
        this.state.retractions.get(r.waterPointId).push(r);
        break;
      }
      case "closure-registered": {
        const c = payload;
        this.state.closureIds.set(c.closureId, c);
        this.state.closures.get(c.waterPointId).push(c);
        break;
      }
      case "route-defined": {
        this.state.routes.set(payload.routeId, payload);
        break;
      }
      case "assessment-frozen": {
        this.state.assessments.set(payload.assessmentId, payload);
        break;
      }
      default:
        throw new Error(`未知事件类型: ${type}`);
    }
  }

  async close() {
    await this.#writeChain;
    await this.#fh?.close();
    this.#fh = null;
  }

  // ---------- 命令 ----------

  async registerWaterPoint(input) {
    const wp = defineWaterPoint(input);
    const { deduplicated } = await this.#append("water-point-registered", wp, {
      key: wp.waterPointId, index: "waterPoints", kind: "水点",
    });
    return { waterPoint: wp, deduplicated };
  }

  async recordObservation(input) {
    const obs = ingestObservation(input);
    if (!this.state.waterPoints.has(obs.waterPointId)) {
      throw new NotFoundError(`水点 ${obs.waterPointId} 尚未注册`);
    }
    const canonical = {
      reportId: obs.reportId,
      waterPointId: obs.waterPointId,
      observerType: obs.observerType,
      sourceLabel: obs.sourceLabel,
      observedAt: obs.observedAt,
      receivedAt: obs.receivedAt,
      flowLevel: obs.flowLevel,
      details: obs.details,
      raw: obs.raw,
    };
    const { deduplicated } = await this.#append("observation-recorded", canonical, {
      key: obs.reportId, index: "reports", kind: "观测报告",
    });
    return { observation: canonical, deduplicated };
  }

  async addRetraction(input) {
    const r = defineRetraction(input);
    if (!this.state.waterPoints.has(r.waterPointId)) {
      throw new NotFoundError(`水点 ${r.waterPointId} 尚未注册`);
    }
    const original = this.state.reports.get(r.reportId);
    if (!original || original.waterPointId !== r.waterPointId) {
      throw new NotFoundError(`撤回引用的原观测 ${r.reportId} 不存在于该水点`);
    }
    const canonical = {
      retractionId: r.retractionId,
      reportId: r.reportId,
      waterPointId: r.waterPointId,
      reason: r.reason,
      receivedAt: r.receivedAt,
      details: r.details,
    };
    const { deduplicated } = await this.#append("retraction-added", canonical, {
      key: r.retractionId, index: "retractionIds", kind: "撤回",
    });
    return { retraction: canonical, deduplicated };
  }

  async registerClosure(input) {
    const c = defineClosure(input);
    if (!this.state.waterPoints.has(c.waterPointId)) {
      throw new NotFoundError(`水点 ${c.waterPointId} 尚未注册`);
    }
    // 同一封闭区间的重复登记按幂等键处理；区间交叠但 closureId 不同是允许的（多机构公告）。
    const canonical = {
      closureId: c.closureId,
      waterPointId: c.waterPointId,
      authority: c.authority,
      reason: c.reason,
      effectiveFrom: c.effectiveFrom,
      effectiveTo: c.effectiveTo,
      issuedAt: c.issuedAt,
      details: c.details,
    };
    const { deduplicated } = await this.#append("closure-registered", canonical, {
      key: c.closureId, index: "closureIds", kind: "封闭",
    });
    return { closure: canonical, deduplicated };
  }

  async defineRoute(input) {
    const route = defineRoute(input);
    for (const p of route.points) {
      if (p.waterPointId && !this.state.waterPoints.has(p.waterPointId)) {
        throw new NotFoundError(`路线节点 ${p.pointId} 引用了未注册水点 ${p.waterPointId}`);
      }
    }
    const canonical = {
      routeId: route.routeId,
      name: route.name,
      points: route.points,
      legs: route.legs,
      order: route.order,
    };
    const { deduplicated } = await this.#append("route-defined", canonical, {
      key: route.routeId, index: "routes", kind: "路线",
    });
    return { route: canonical, deduplicated };
  }

  async assessTrip(routeId, input) {
    const route = this.state.routes.get(routeId);
    if (!route) throw new NotFoundError(`路线 ${routeId} 不存在`);
    const itinerary = defineItineraryInput(input, route);

    // 内容寻址：同一证据状态 + 同一路线 + 同一行程输入 → 同一 assessmentId。
    // 证据指纹只含“可影响结论”的状态（不含历史评估自身），
    // 因此：进程重启后重查逐字节一致；而新证据到来后同参数会得到一个新的评估，
    // 旧评估仍可按其 ID 永久审计。
    const assessmentId = createHash("sha256")
      .update(stableStringify({ routeId, itinerary, evidenceFingerprint: this.evidenceFingerprint() }))
      .digest("hex")
      .slice(0, 16);

    const existing = this.state.assessments.get(assessmentId);
    if (existing) return { assessment: existing, deduplicated: true };

    const result = planTrip({
      route,
      waterPoints: this.state.waterPoints,
      observationsByPoint: this.state.observations,
      retractionsByPoint: this.state.retractions,
      closuresByPoint: this.state.closures,
      itinerary,
      assessmentId,
    });
    const canonical = { assessmentId, routeId, input: itinerary, evidenceFingerprint: this.evidenceFingerprint(), result };
    const { deduplicated } = await this.#append("assessment-frozen", canonical, {
      key: assessmentId, index: "assessments", kind: "行程评估",
    });
    return { assessment: canonical, deduplicated };
  }

  // 证据指纹：对影响结论的全部状态做规范化哈希（按标识排序，与插入/到达顺序无关）。
  evidenceFingerprint() {
    const s = this.state;
    const sortedValues = (map, key) => [...map.values()].sort((a, b) => (a[key] < b[key] ? -1 : 1));
    const grouped = (map) =>
      [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, list]) => [k, [...list].sort((a, b) =>
        (a.reportId ?? a.retractionId ?? a.closureId ?? "") < (b.reportId ?? b.retractionId ?? b.closureId ?? "") ? -1 : 1)]);
    return createHash("sha256").update(stableStringify({
      waterPoints: sortedValues(s.waterPoints, "waterPointId"),
      reports: sortedValues(s.reports, "reportId"),
      retractions: sortedValues(s.retractionIds, "retractionId"),
      closures: sortedValues(s.closureIds, "closureId"),
      routes: sortedValues(s.routes, "routeId"),
      observations: grouped(s.observations),
    })).digest("hex");
  }

  // ---------- 查询 ----------

  getWaterPoint(id) {
    const wp = this.state.waterPoints.get(id);
    if (!wp) throw new NotFoundError(`水点 ${id} 不存在`);
    return wp;
  }
  listWaterPoints() {
    return [...this.state.waterPoints.values()];
  }
  listObservations(id) {
    this.getWaterPoint(id);
    return this.state.observations.get(id) ?? [];
  }
  listRetractions(id) {
    this.getWaterPoint(id);
    return this.state.retractions.get(id) ?? [];
  }
  listClosures(id) {
    this.getWaterPoint(id);
    return this.state.closures.get(id) ?? [];
  }
  getRoute(id) {
    const route = this.state.routes.get(id);
    if (!route) throw new NotFoundError(`路线 ${id} 不存在`);
    return route;
  }
  listRoutes() {
    return [...this.state.routes.values()];
  }
  getAssessment(id) {
    const a = this.state.assessments.get(id);
    if (!a) throw new NotFoundError(`行程评估 ${id} 不存在`);
    return a;
  }
  listAssessments() {
    return [...this.state.assessments.values()];
  }
}

function serializeState(s) {
  return {
    waterPoints: [...s.waterPoints.values()],
    reports: [...s.reports.values()],
    retractions: [...s.retractionIds.values()],
    closures: [...s.closureIds.values()],
    routes: [...s.routes.values()],
    assessments: [...s.assessments.values()],
  };
}

function deserializeState(data) {
  const s = freshState();
  for (const wp of data.waterPoints ?? []) {
    s.waterPoints.set(wp.waterPointId, wp);
    s.observations.set(wp.waterPointId, []);
    s.retractions.set(wp.waterPointId, []);
    s.closures.set(wp.waterPointId, []);
  }
  for (const obs of data.reports ?? []) {
    s.reports.set(obs.reportId, obs);
    s.observations.get(obs.waterPointId)?.push(obs);
  }
  for (const r of data.retractions ?? []) {
    s.retractionIds.set(r.retractionId, r);
    s.retractions.get(r.waterPointId)?.push(r);
  }
  for (const c of data.closures ?? []) {
    s.closureIds.set(c.closureId, c);
    s.closures.get(c.waterPointId)?.push(c);
  }
  for (const route of data.routes ?? []) s.routes.set(route.routeId, route);
  for (const a of data.assessments ?? []) s.assessments.set(a.assessmentId, a);
  return s;
}
