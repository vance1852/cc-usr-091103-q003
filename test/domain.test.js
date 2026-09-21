import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore, stableStringify } from "../src/store/event-store.js";
import { assessWaterPoint } from "../src/domain/assessment.js";

const HOUR = 3600_000;
const DAY = 86400_000;
const T = Date.parse("2026-09-21T08:00:00+08:00");
const iso = (ms) => new Date(ms).toISOString();

const stores = new Set();
const dirs = new Set();
after(async () => {
  for (const s of stores) {
    try { await s.close(); } catch {}
  }
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function newStore() {
  const dir = await mkdtemp(join(tmpdir(), "water-store-"));
  const store = new EventStore(dir);
  await store.recover();
  stores.add(store);
  dirs.add(dir);
  return { store, dir };
}

async function registerSpring(store, id = "spring-1") {
  await store.registerWaterPoint({
    waterPointId: id,
    name: "北山泉",
    location: { description: "垭口下方三百米石缝", coordinates: { lat: 30.12, lon: 121.4 }, elevation: 1820 },
  });
}

test("两周前水量充足 + 当天断流报告 => 此刻不可依赖，正反原始观测都在", async () => {
  const { store } = await newStore();
  await registerSpring(store);
  await store.recordObservation({
    reportId: "hiker-old", waterPointId: "spring-1", observerType: "hiker",
    observedAt: iso(T - 14 * DAY), receivedAt: iso(T - 14 * DAY), flowLevel: "strong",
    evidenceDigest: "sha256:old", note: "水量充足，直接饮用",
  });
  await store.recordObservation({
    reportId: "ranger-now", waterPointId: "spring-1", observerType: "ranger",
    observedAt: iso(T - 2 * HOUR), receivedAt: iso(T - HOUR), flowLevel: "dry",
    evidenceDigest: "sha256:new", note: "泉眼完全断流，石缝发白",
  });

  const a = assessWaterPoint(store.getWaterPoint("spring-1"), store.listObservations("spring-1"), [], [], T);
  assert.equal(a.status, "unreliable");
  assert.equal(a.opposingEvidence[0].reportId, "ranger-now");
  // 旧报告已过期，不参与加权，但仍作为原始证据保留在 staleEvidence 中。
  assert.equal(a.staleEvidence[0].reportId, "hiker-old");
  assert.equal(a.staleEvidence[0].summary, "水量充足，直接饮用");
  assert.ok(a.decaysAt);
});

test("护林员/客栈/徒步者相互冲突时不覆盖，结论为 conflicting 且双方证据并列", async () => {
  const { store } = await newStore();
  await registerSpring(store);
  await store.recordObservation({
    reportId: "r1", waterPointId: "spring-1", observerType: "ranger",
    observedAt: iso(T - HOUR), receivedAt: iso(T), flowLevel: "dry", note: "断流",
  });
  await store.recordObservation({
    reportId: "l1", waterPointId: "spring-1", observerType: "lodging-host",
    observedAt: iso(T - 2 * HOUR), receivedAt: iso(T), flowLevel: "usable", note: "今天还能接水",
  });
  await store.recordObservation({
    reportId: "h1", waterPointId: "spring-1", observerType: "hiker",
    observedAt: iso(T - 2 * HOUR), receivedAt: iso(T), flowLevel: "strong", note: "水很大",
  });
  const a = assessWaterPoint(store.getWaterPoint("spring-1"), store.listObservations("spring-1"), [], [], T);
  assert.equal(a.status, "conflicting");
  assert.deepEqual(a.supportingEvidence.map((e) => e.reportId).sort(), ["h1", "l1"]);
  assert.deepEqual(a.opposingEvidence.map((e) => e.reportId), ["r1"]);
  // 没有任何一方被覆盖：三造都带着各自权重留在证据中
  assert.equal(a.evidence.length, 3);
  assert.ok(a.masses.positive > 0 && a.masses.negative > 0);
});

test("证据确定顺序只按 (observedAt, reportId)，迟到报告不重排既有结论", async () => {
  const { store } = await newStore();
  await registerSpring(store);
  // 先到 A（观测时刻较晚），迟到 B（观测时刻较早）
  await store.recordObservation({
    reportId: "A", waterPointId: "spring-1", observerType: "ranger",
    observedAt: iso(T - 3 * HOUR), receivedAt: iso(T - 2 * HOUR), flowLevel: "usable",
  });
  const before = assessWaterPoint(store.getWaterPoint("spring-1"), store.listObservations("spring-1"), [], [], T);
  await store.recordObservation({
    reportId: "B", waterPointId: "spring-1", observerType: "ranger",
    observedAt: iso(T - 5 * HOUR), receivedAt: iso(T - HOUR), flowLevel: "usable",
  });
  const after = assessWaterPoint(store.getWaterPoint("spring-1"), store.listObservations("spring-1"), [], [], T);
  // evidence 为按 (observedAt, reportId) 的确定顺序；B 观测时刻更早，排前
  assert.equal(after.evidence[0].reportId, "B");
  assert.equal(after.evidence[1].reportId, "A");
  // 迟到前 A 独立结论不受影响
  assert.equal(before.evidence[0].reportId, "A");
});

test("相同报告重传幂等；内容冲突的重传被拒绝而非覆盖", async () => {
  const { store } = await newStore();
  await registerSpring(store);
  const payload = {
    reportId: "dup-1", waterPointId: "spring-1", observerType: "hiker",
    observedAt: iso(T - HOUR), receivedAt: iso(T), flowLevel: "trickle", note: "细流",
  };
  const r1 = await store.recordObservation(payload);
  const r2 = await store.recordObservation({ ...payload, note: "细流" });
  assert.equal(r1.deduplicated, false);
  assert.equal(r2.deduplicated, true);
  assert.equal(store.listObservations("spring-1").length, 1);

  await assert.rejects(
    () => store.recordObservation({ ...payload, flowLevel: "dry" }),
    /已存在且负载不一致/
  );
  assert.equal(store.listObservations("spring-1").length, 1);
});

test("撤回只追加说明：原报告保留、移出加权；撤回之前时刻的评估不受影响", async () => {
  const { store } = await newStore();
  await registerSpring(store);
  await store.recordObservation({
    reportId: "false-dry", waterPointId: "spring-1", observerType: "hiker",
    observedAt: iso(T - 3 * HOUR), receivedAt: iso(T - 2 * HOUR), flowLevel: "dry", note: "干了",
  });
  await store.addRetraction({
    retractionId: "ret-1", reportId: "false-dry", waterPointId: "spring-1",
    reason: "看错了水点，实际是隔壁废井", receivedAt: iso(T - HOUR),
  });
  const a = assessWaterPoint(store.getWaterPoint("spring-1"), store.listObservations("spring-1"), store.listRetractions("spring-1"), [], T);
  assert.equal(a.status, "unknown"); // 误报被撤回后无在期证据
  assert.equal(a.retractedEvidence[0].reportId, "false-dry");
  assert.match(a.retractedEvidence[0].retraction.reason, /看错了/);

  // 在撤回生效“之前”的评估时刻，误报仍参与（行政撤回不能追溯改写历史判断）
  const before = assessWaterPoint(store.getWaterPoint("spring-1"), store.listObservations("spring-1"), store.listRetractions("spring-1"), [], T - 90 * 60_000);
  assert.equal(before.status, "unreliable");
});

test("官方封闭按独立生效区间作用，区间外恢复为观测结论", async () => {
  const { store } = await newStore();
  await registerSpring(store);
  await store.recordObservation({
    reportId: "ok-1", waterPointId: "spring-1", observerType: "ranger",
    observedAt: iso(T - HOUR), receivedAt: iso(T), flowLevel: "strong",
  });
  await store.registerClosure({
    closureId: "c-1", waterPointId: "spring-1", authority: "景区管理局",
    reason: "上游施工，封闭取水", effectiveFrom: iso(T + 2 * HOUR), effectiveTo: iso(T + 6 * HOUR),
  });
  const obs = store.listObservations("spring-1");
  const cls = store.listClosures("spring-1");
  assert.equal(assessWaterPoint(store.getWaterPoint("spring-1"), obs, [], cls, T).status, "reliable");
  assert.equal(assessWaterPoint(store.getWaterPoint("spring-1"), obs, [], cls, T + 3 * HOUR).status, "closed");
  assert.equal(assessWaterPoint(store.getWaterPoint("spring-1"), obs, [], cls, T + 7 * HOUR).status, "reliable");
});

test("未知属性（证据摘要、照片、坐标）原样保存并在重启后保留", async () => {
  const { store, dir } = await newStore();
  await registerSpring(store);
  await store.recordObservation({
    reportId: "x-1", waterPointId: "spring-1", observerType: "lodging-host",
    observedAt: iso(T - HOUR), receivedAt: iso(T), flowLevel: "usable",
    evidenceDigest: "sha256:abc", photoUrl: "https://example/x.jpg", flowGaugeLitersMin: 4.2,
  });
  await store.close();

  const recovered = new EventStore(dir);
  await recovered.recover();
  const obs = recovered.listObservations("spring-1")[0];
  assert.equal(obs.details.evidenceDigest, "sha256:abc");
  assert.equal(obs.details.photoUrl, "https://example/x.jpg");
  assert.equal(obs.details.flowGaugeLitersMin, 4.2);
  assert.equal(recovered.getWaterPoint("spring-1").location.coordinates.lat, 30.12);
  await recovered.close();
  await rm(dir, { recursive: true, force: true });
});

test("重启后重查同一行程：风险段与推导依据逐字节一致，assessmentId 相同", async () => {
  const { store, dir } = await newStore();
  await seedRoute(store);
  const input = {
    partySize: 2, startAt: iso(T), litersPerPersonHour: 0.5, reserveRatio: 0.25,
    legDurations: { "l-0-1": 120, "l-1-2": 240 },
  };
  const first = await store.assessTrip("ridge-line", input);
  const firstJson = stableStringify(first.assessment.result);
  await store.close();

  const recovered = new EventStore(dir);
  await recovered.recover();
  const again = await recovered.assessTrip("ridge-line", input);
  assert.equal(again.deduplicated, true);
  assert.equal(again.assessment.assessmentId, first.assessment.assessmentId);
  assert.equal(stableStringify(again.assessment.result), firstJson);

  const fetched = recovered.getAssessment(first.assessment.assessmentId);
  assert.equal(stableStringify(fetched.result), firstJson);
  await recovered.close();
  await rm(dir, { recursive: true, force: true });
});

test("行程推导：识别补水缺口、风险段与携水安全余量", async () => {
  const { store } = await newStore();
  await seedRoute(store); // p1 当天断流，p2 可靠
  const { assessment } = await store.assessTrip("ridge-line", {
    partySize: 2, startAt: iso(T), litersPerPersonHour: 0.5, reserveRatio: 0.25,
    legDurations: { "l-0-1": 120, "l-1-2": 240 },
  });
  const result = assessment.result;
  // p1 不可靠 → 唯一一段从起点直贯 p2，360 分钟
  assert.equal(result.segments.length, 1);
  const seg = result.segments[0];
  assert.equal(seg.durationMinutes, 360);
  assert.equal(seg.waterNeedLiters, 6);      // 6h × 0.5L × 2 人
  assert.equal(seg.reserveLiters, 1.5);     // 25%
  assert.equal(seg.carryRequiredLiters, 7.5);
  assert.equal(seg.waterPointsWithin[0].status, "unreliable");
  assert.equal(result.summary.maxCarryRequiredLiters, 7.5);
  assert.ok(result.summary.criticalSegmentCount === 0); // 终点可靠
});

test("终点也不可靠时该段为 critical", async () => {
  const { store } = await newStore();
  await registerSpring(store, "spring-a");
  await registerSpring(store, "spring-b");
  await store.defineRoute({
    routeId: "r2", name: "旱沟线",
    points: [
      { pointId: "p0", name: "沟口" },
      { pointId: "p1", name: "一营地", waterPointId: "spring-a" },
    ],
    legs: [{ legId: "l1", fromPointId: "p0", toPointId: "p1", durationMinutes: 300 }],
  });
  await store.recordObservation({
    reportId: "dry-a", waterPointId: "spring-a", observerType: "ranger",
    observedAt: iso(T - HOUR), receivedAt: iso(T), flowLevel: "dry",
  });
  const { assessment } = await store.assessTrip("r2", { partySize: 3, startAt: iso(T) });
  assert.equal(assessment.result.segments[0].risk, "critical");
  assert.equal(assessment.result.summary.criticalSegmentCount, 1);
});

test("证据状态变化后同参数产生新评估（旧评估保留可审计），证据不变则永久幂等", async () => {
  const { store } = await newStore();
  await seedRoute(store);
  const input = { partySize: 2, startAt: iso(T) };
  const a1 = await store.assessTrip("ridge-line", input);
  const a1Again = await store.assessTrip("ridge-line", input);
  assert.equal(a1Again.assessment.assessmentId, a1.assessment.assessmentId);
  assert.equal(a1Again.deduplicated, true);

  // 新证据：spring-a 从断流变为有水 → 风险结构改变 → 新评估 ID
  await store.recordObservation({
    reportId: "a-recovered", waterPointId: "spring-a", observerType: "ranger",
    observedAt: iso(T - 30 * 60_000), receivedAt: iso(T - 10 * 60_000), flowLevel: "strong",
  });
  const a2 = await store.assessTrip("ridge-line", input);
  assert.notEqual(a2.assessment.assessmentId, a1.assessment.assessmentId);
  // 旧评估仍可按原 ID 取到，推导依据没有被改写
  const old = store.getAssessment(a1.assessment.assessmentId);
  assert.equal(old.assessmentId, a1.assessment.assessmentId);
  assert.notEqual(stableStringify(old.result), stableStringify(a2.assessment.result));
});

async function seedRoute(store) {
  await registerSpring(store, "spring-a");
  await registerSpring(store, "spring-b");
  await store.recordObservation({
    reportId: "a-dry", waterPointId: "spring-a", observerType: "ranger",
    observedAt: iso(T - HOUR), receivedAt: iso(T), flowLevel: "dry", note: "断流",
  });
  await store.recordObservation({
    reportId: "b-strong", waterPointId: "spring-b", observerType: "ranger",
    observedAt: iso(T - HOUR), receivedAt: iso(T), flowLevel: "strong",
  });
  await store.defineRoute({
    routeId: "ridge-line", name: "脊线两日",
    points: [
      { pointId: "p0", name: " trailhead" },
      { pointId: "p1", name: "一营地", waterPointId: "spring-a" },
      { pointId: "p2", name: "二营地", waterPointId: "spring-b" },
    ],
    legs: [
      { legId: "l-0-1", fromPointId: "p0", toPointId: "p1", durationMinutes: 120 },
      { legId: "l-1-2", fromPointId: "p1", toPointId: "p2", durationMinutes: 180 },
    ],
  });
}
