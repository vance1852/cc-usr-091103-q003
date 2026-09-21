import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../src/store/event-store.js";
import { createService } from "../src/domain/service.js";
import { createHttpServer } from "../src/http/server.js";

function startServer(file) {
  const store = new EventStore(file).open();
  const service = createService(store);
  const server = createHttpServer(service);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        port,
        store,
        url: (path) => `http://127.0.0.1:${port}${path}`,
        stop: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => {
              store.close();
              done();
            });
          }),
      });
    });
  });
}

async function post(api, path, body) {
  const res = await fetch(api.url(path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test("HTTP 端到端：摄入冲突证据→实时判定→行程缺口，重启进程后 API 响应一致", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "water-intel-http-"));
  const file = join(dir, "events.log");
  const api = await startServer(file);

  try {
    for (const [id, name] of [
      ["camp-spring", "营地泉"],
      ["pass-spring", "垭口泉"],
      ["valley-tap", "沟谷水龙头"],
    ]) {
      const r = await post(api, "/api/water-points", { waterPointId: id, name });
      assert.equal(r.status, 201);
    }

    // 两周前的“水量充足”记录
    assert.equal(
      (
        await post(api, "/api/reports", {
          reportId: "old-strong",
          waterPointId: "pass-spring",
          observerType: "hiker",
          observedAt: "2026-08-31T08:00:00+08:00",
          receivedAt: "2026-08-31T10:00:00+08:00",
          flowLevel: "strong",
          note: "两周前记录：水量充足",
        })
      ).status,
      201,
    );

    // 重传：幂等 200
    const dup = await post(api, "/api/reports", {
      reportId: "old-strong",
      waterPointId: "pass-spring",
      observerType: "hiker",
      observedAt: "2026-08-31T08:00:00+08:00",
      receivedAt: "2026-08-31T10:00:00+08:00",
      flowLevel: "strong",
      note: "两周前记录：水量充足",
    });
    assert.equal(dup.status, 200);
    assert.equal(dup.json.duplicated, true);

    // 同 id 改结论：409
    const conflict = await post(api, "/api/reports", {
      reportId: "old-strong",
      waterPointId: "pass-spring",
      observerType: "hiker",
      observedAt: "2026-08-31T08:00:00+08:00",
      receivedAt: "2026-08-31T10:00:00+08:00",
      flowLevel: "dry",
    });
    assert.equal(conflict.status, 409);

    // 当天断流新报告
    assert.equal(
      (
        await post(api, "/api/reports", {
          reportId: "ranger-dry-today",
          waterPointId: "pass-spring",
          observerType: "ranger",
          observedAt: "2026-09-14T05:30:00+08:00",
          receivedAt: "2026-09-14T06:00:00+08:00",
          flowLevel: "dry",
          evidenceDigest: "sha256:9f8e",
          note: "泉眼已断流",
        })
      ).status,
      201,
    );

    // 误报撤回示例：营地泉曾错报 usable，撤回后追加说明
    await post(api, "/api/reports", {
      reportId: "camp-false",
      waterPointId: "camp-spring",
      observerType: "hiker",
      observedAt: "2026-09-13T10:00:00+08:00",
      receivedAt: "2026-09-13T12:00:00+08:00",
      flowLevel: "usable",
    });
    const retr = await post(api, "/api/reports/camp-false/retractions", {
      reason: "看错了岔沟",
      source: "self",
    });
    assert.equal(retr.status, 201);
    assert.equal(retr.json.retractionCount, 1);

    // 沟谷水龙头可靠
    await post(api, "/api/reports", {
      reportId: "valley-ok",
      waterPointId: "valley-tap",
      observerType: "lodging-host",
      observedAt: "2026-09-14T04:00:00+08:00",
      receivedAt: "2026-09-14T04:10:00+08:00",
      flowLevel: "usable",
    });

    // 未来封闭区间
    await post(api, "/api/closures", {
      closureId: "closure-15",
      waterPointId: "valley-tap",
      startAt: "2026-09-16T00:00:00+08:00",
      endAt: "2026-09-18T00:00:00+08:00",
      reason: "管道检修",
      issuedBy: "管护站",
    });

    // 打开水点：先看到此刻是否值得依赖 + 衰减时刻 + 正反原始观测
    const assessUrl = `/api/water-points/pass-spring?asOf=${encodeURIComponent("2026-09-14T08:00:00+08:00")}`;
    const assessRes = await fetch(api.url(assessUrl));
    assert.equal(assessRes.status, 200);
    const assessment = await assessRes.json();
    assert.equal(assessment.status, "unreliable");
    assert.equal(assessment.conclusionExpiresAt, "2026-09-16T21:30:00.000Z");
    assert.equal(assessment.evidence.supporting[0].reportId, "old-strong");
    assert.equal(assessment.evidence.supporting[0].fresh, false);
    assert.equal(assessment.evidence.opposing[0].reportId, "ranger-dry-today");
    assert.equal(assessment.evidence.opposing[0].details.evidenceDigest, "sha256:9f8e");
    const stateHash = assessment.meta.stateHash;
    assert.equal(assessment.meta.seq, 9);

    // 队伍人数与各路段耗时 → 补水缺口与安全余量
    const planRes = await post(api, "/api/trips/plan", {
      startAt: "2026-09-14T08:00:00+08:00",
      partySize: 4,
      perPersonCarryCapacityLiters: 6,
      legs: [
        { toWaterPointId: "camp-spring", durationHours: 2 },
        { toWaterPointId: "pass-spring", durationHours: 6 },
        { toWaterPointId: "valley-tap", durationHours: 4 },
      ],
    });
    assert.equal(planRes.status, 200);
    const plan = planRes.json;
    // camp-spring 证据被撤回（unknown）、pass-spring 断流：走到 valley-tap 前共 12 小时无水可补
    assert.deepEqual(plan.riskLegs.map((r) => r.toWaterPointId), ["camp-spring", "pass-spring"]);
    assert.equal(plan.summary.riskLegCount, 2);
    const firstSegment = plan.segments[0];
    assert.equal(firstSegment.endsWithReliableRefill, true);
    // 4 人 × 12h × 0.5L × 1.25 安全系数 = 30L，余量 6L
    assert.equal(firstSegment.demandLiters, 24);
    assert.equal(firstSegment.recommendedCarryLiters, 30);
    assert.equal(firstSegment.safetyMarginLiters, 6);
    // 4 人共 24L 容量：30L 安全口径装不下，触发容量告警
    assert.equal(firstSegment.exceedsCarryCapacity, true);
    assert.equal(plan.summary.maxRecommendedCarryLiters, 30);
    assert.equal(plan.meta.stateHash, stateHash);

    // 封闭区间在行程到达时刻生效：valley-tap 到达为 09-14 20:00，尚未封闭
    assert.equal(plan.legs[2].arrivalStatus, "reliable");

    // 重启进程：重放同一日志，同一查询逐字节一致
    await api.stop();
    const api2 = await startServer(file);
    try {
      const [a1, p1] = await Promise.all([
        fetch(api2.url(assessUrl)).then((r) => r.json()),
        post(api2, "/api/trips/plan", {
          startAt: "2026-09-14T08:00:00+08:00",
          partySize: 4,
          perPersonCarryCapacityLiters: 6,
          legs: [
            { toWaterPointId: "camp-spring", durationHours: 2 },
            { toWaterPointId: "pass-spring", durationHours: 6 },
            { toWaterPointId: "valley-tap", durationHours: 4 },
          ],
        }).then((r) => r.json),
      ]);
      assert.equal(a1.meta.stateHash, stateHash);
      assert.deepEqual(a1, assessment);
      assert.deepEqual(p1, plan);
    } finally {
      await api2.stop();
    }
  } finally {
    if (api.store.fd !== null) await api.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test("非法协议字段与错误路由返回结构化错误", async () => {
  const dir = mkdtempSync(join(tmpdir(), "water-intel-http-err-"));
  const file = join(dir, "events.log");
  const api = await startServer(file);
  try {
    const bad = await post(api, "/api/reports", {
      reportId: "x",
      waterPointId: "w",
      observerType: "hiker",
      observedAt: "t",
      receivedAt: "t",
      flowLevel: "flood",
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, "invalid_request");

    const missing = await fetch(api.url("/api/water-points/nope"));
    assert.equal(missing.status, 404);

    const noRoute = await fetch(api.url("/api/nope"));
    assert.equal(noRoute.status, 404);
  } finally {
    await api.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
