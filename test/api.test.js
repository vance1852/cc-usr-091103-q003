import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../src/store/event-store.js";
import { createApp } from "../src/http/api.js";

const HOUR = 3600_000;
const T = Date.parse("2026-09-21T08:00:00+08:00");
const iso = (ms) => new Date(ms).toISOString();

const dirs = [];
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function startServer() {
  const dir = await mkdtemp(join(tmpdir(), "water-api-"));
  dirs.push(dir);
  const store = new EventStore(dir);
  await store.recover();
  const server = createApp(store, () => T);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  return {
    base, dir, store,
    stop: () => Promise.all([new Promise((r) => server.close(r)), store.close()]),
  };
}

async function jsonFetch(base, path, init = {}) {
  const res = await fetch(base + path, {
    method: init.method ?? "GET",
    headers: init.body ? { "content-type": "application/json" } : undefined,
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const body = await res.json();
  return { status: res.status, body };
}

test("API 全链路：注册水点 → 矛盾观测 → 查看当前结论 → 行程评估 → 重启复现", async () => {
  const sv = await startServer();
  const { base } = sv;

  const wp = await jsonFetch(base, "/water-points", {
    method: "POST",
    body: { waterPointId: "spring-204", name: "204 泉", location: { description: "垭口下方石缝", km: 12.4 } },
  });
  assert.equal(wp.status, 201);
  assert.equal(wp.body.data.location.km, 12.4); // 未知位置属性保留

  // 两周前“水量充足”
  await jsonFetch(base, "/water-points/spring-204/observations", {
    method: "POST",
    body: {
      reportId: "old-strong", waterPointId: "spring-204", observerType: "hiker",
      observedAt: iso(T - 14 * 86400_000), receivedAt: iso(T - 14 * 86400_000),
      flowLevel: "strong", evidenceDigest: "sha256:old", note: "水量充足",
    },
  });
  // 当天护林员断流报告
  await jsonFetch(base, "/water-points/spring-204/observations", {
    method: "POST",
    body: {
      reportId: "new-dry", waterPointId: "spring-204", observerType: "ranger",
      observedAt: iso(T - 2 * HOUR), receivedAt: iso(T - HOUR),
      flowLevel: "dry", evidenceDigest: "sha256:new", note: "泉眼断流",
    },
  });

  // 同报告重传：200 + deduplicated，证据数量不变
  const dup = await jsonFetch(base, "/water-points/spring-204/observations", {
    method: "POST",
    body: {
      reportId: "new-dry", waterPointId: "spring-204", observerType: "ranger",
      observedAt: iso(T - 2 * HOUR), receivedAt: iso(T - HOUR),
      flowLevel: "dry", evidenceDigest: "sha256:new", note: "泉眼断流",
    },
  });
  assert.equal(dup.status, 200);
  assert.equal(dup.body.meta.deduplicated, true);

  // 冲突重传：409
  const conflict = await jsonFetch(base, "/water-points/spring-204/observations", {
    method: "POST",
    body: {
      reportId: "new-dry", waterPointId: "spring-204", observerType: "ranger",
      observedAt: iso(T - 2 * HOUR), receivedAt: iso(T - HOUR), flowLevel: "usable",
    },
  });
  assert.equal(conflict.status, 409);

  // 此刻结论：不可依赖，反对方为当天断流报告，旧报告在过期区
  const now = await jsonFetch(base, "/water-points/spring-204/assessment");
  assert.equal(now.status, 200);
  assert.equal(now.body.data.status, "unreliable");
  assert.equal(now.body.data.opposingEvidence[0].reportId, "new-dry");
  assert.equal(now.body.data.staleEvidence[0].reportId, "old-strong");
  assert.ok(now.body.data.decaysAt);

  // 非法时间（无时区）→ 400
  const badTime = await jsonFetch(base, "/water-points/spring-204/assessment?at=2026-09-21T08:00:00");
  assert.equal(badTime.status, 400);

  // 撤回只能追加
  const retract = await jsonFetch(base, "/water-points/spring-204/retractions", {
    method: "POST",
    body: { retractionId: "rt-1", reportId: "new-dry", reason: "编号张冠李戴", receivedAt: iso(T) },
  });
  assert.equal(retract.status, 201);
  const afterRetract = await jsonFetch(base, "/water-points/spring-204/assessment");
  assert.equal(afterRetract.body.data.retractedEvidence[0].retraction.reason, "编号张冠李戴");

  // 官方封闭区间
  const closure = await jsonFetch(base, "/water-points/spring-204/closures", {
    method: "POST",
    body: {
      closureId: "cl-1", authority: "林管局", reason: "生态修复",
      effectiveFrom: iso(T + HOUR), effectiveTo: iso(T + 30 * 24 * 3600_000),
    },
  });
  assert.equal(closure.status, 201);
  const closed = await jsonFetch(base, `/water-points/spring-204/assessment?at=${encodeURIComponent(iso(T + 2 * HOUR))}`);
  assert.equal(closed.body.data.status, "closed");

  // 路线 + 行程推导
  await jsonFetch(base, "/water-points", {
    method: "POST",
    body: { waterPointId: "spring-300", name: "300 营地水源", location: { description: "二营地下方" } },
  });
  await jsonFetch(base, "/water-points/spring-300/observations", {
    method: "POST",
    body: {
      reportId: "s300-ok", waterPointId: "spring-300", observerType: "lodging-host",
      observedAt: iso(T - 3 * HOUR), receivedAt: iso(T - 2 * HOUR), flowLevel: "usable", note: "稳定",
    },
  });
  await jsonFetch(base, "/routes", {
    method: "POST",
    body: {
      routeId: "ridge", name: "脊线",
      points: [
        { pointId: "p0", name: "山口" },
        { pointId: "p1", name: "204 营地", waterPointId: "spring-204" },
        { pointId: "p2", name: "300 营地", waterPointId: "spring-300" },
      ],
      legs: [
        { legId: "l1", fromPointId: "p0", toPointId: "p1", durationMinutes: 150 },
        { legId: "l2", fromPointId: "p1", toPointId: "p2", durationMinutes: 240 },
      ],
    },
  });
  const trip = await jsonFetch(base, "/routes/ridge/trip-assessments", {
    method: "POST",
    body: {
      partySize: 4, startAt: iso(T), litersPerPersonHour: 0.5, reserveRatio: 0.25,
      legDurations: { l1: 180, l2: 300 },
    },
  });
  assert.equal(trip.status, 201);
  // 204 在抵达时（T+3h）正处于封闭区间 → 整段直贯 300（T+8h）：
  // 480 分钟 × 0.5L/h × 4 人 = 16L，余量 25% = 4L，应携带 20L。
  assert.equal(trip.body.data.segments.length, 1);
  assert.equal(trip.body.data.summary.maxCarryRequiredLiters, 20);
  assert.equal(trip.body.data.segments[0].waterNeedLiters, 16);
  assert.equal(trip.body.data.segments[0].reserveLiters, 4);
  const assessmentId = trip.body.meta.assessmentId;

  // 重启：新进程、新 store，同一输入得到同一 assessmentId（幂等命中）与同一结论
  await sv.stop();
  const sv2 = await startServerWithDir(sv.dir, T);
  const trip2 = await jsonFetch(sv2.base, "/routes/ridge/trip-assessments", {
    method: "POST",
    body: {
      partySize: 4, startAt: iso(T), litersPerPersonHour: 0.5, reserveRatio: 0.25,
      legDurations: { l1: 180, l2: 300 },
    },
  });
  assert.equal(trip2.body.meta.assessmentId, assessmentId);
  assert.equal(trip2.body.meta.deduplicated, true);
  const fetched = await jsonFetch(sv2.base, `/trip-assessments/${assessmentId}`);
  assert.equal(fetched.body.data.summary.maxCarryRequiredLiters, 20);
  await sv2.stop();
});

async function startServerWithDir(dir, nowMs) {
  const store = new EventStore(dir);
  await store.recover();
  const server = createApp(store, () => nowMs);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  return {
    base, store,
    stop: () => Promise.all([new Promise((r) => server.close(r)), store.close()]),
  };
}
