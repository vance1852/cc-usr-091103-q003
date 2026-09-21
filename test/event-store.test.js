import test from "node:test";
import assert from "node:assert/strict";
import { makeHarness } from "../test-helpers/harness.js";

const baseReport = {
  reportId: "dup-1",
  waterPointId: "wp-d",
  observerType: "hiker",
  observedAt: "2026-09-14T06:00:00+08:00",
  receivedAt: "2026-09-14T06:30:00+08:00",
  flowLevel: "usable",
};

test("相同报告重传幂等：不追加事件、不改变 stateHash 与入库序号", () => {
  const h = makeHarness();
  const { service, store } = h;
  service.registerWaterPoint({ waterPointId: "wp-d" });
  const first = service.ingestReport({ ...baseReport });
  const hashAfterFirst = store.stateHash();
  const seqAfterFirst = store.seq;

  const second = service.ingestReport({ ...baseReport });
  assert.equal(second.duplicated, true);
  assert.equal(second.ingestSeq, first.ingestSeq);
  assert.equal(store.seq, seqAfterFirst);
  assert.equal(store.stateHash(), hashAfterFirst);

  // 字段书写顺序不同也视为同一报告
  const reordered = {
    flowLevel: baseReport.flowLevel,
    receivedAt: baseReport.receivedAt,
    observedAt: baseReport.observedAt,
    observerType: baseReport.observerType,
    waterPointId: baseReport.waterPointId,
    reportId: baseReport.reportId,
  };
  const third = service.ingestReport(reordered);
  assert.equal(third.duplicated, true);
  assert.equal(store.stateHash(), hashAfterFirst);

  h.cleanup();
});

test("同一 reportId 内容冲突时拒绝，不能覆盖既有证据", () => {
  const h = makeHarness();
  const { service } = h;
  service.registerWaterPoint({ waterPointId: "wp-d" });
  service.ingestReport({ ...baseReport });
  assert.throws(
    () => service.ingestReport({ ...baseReport, flowLevel: "dry" }),
    (err) => err.statusCode === 409,
  );
  const a = service.assess("wp-d", "2026-09-14T08:00:00+08:00");
  assert.equal(a.status, "reliable"); // 仍是首次内容
  h.cleanup();
});

test("迟到报告按观测时刻插入证据序列，不按到达先后排列", () => {
  const h = makeHarness();
  const { service } = h;
  service.registerWaterPoint({ waterPointId: "wp-o" });
  service.ingestReport({
    reportId: "later-observation",
    waterPointId: "wp-o",
    observerType: "hiker",
    observedAt: "2026-09-14T09:00:00+08:00",
    receivedAt: "2026-09-14T09:05:00+08:00",
    flowLevel: "usable",
  });
  // 迟到两天的更早观测
  service.ingestReport({
    reportId: "earlier-observation",
    waterPointId: "wp-o",
    observerType: "hiker",
    observedAt: "2026-09-13T09:00:00+08:00",
    receivedAt: "2026-09-15T20:00:00+08:00",
    flowLevel: "usable",
  });
  const a = service.assess("wp-o", "2026-09-15T21:00:00+08:00");
  assert.deepEqual(
    a.evidence.supporting.map((e) => e.reportId),
    ["earlier-observation", "later-observation"],
  );
  h.cleanup();
});

test("进程重启后重放日志：stateHash 一致，同一行程得到逐字节相同的结论与依据", () => {
  const h = makeHarness();
  const { service } = h;
  for (const [id, name] of [
    ["wp-a", "A 营地水源"],
    ["wp-b", "B 垭口泉"],
    ["wp-c", "C 山沟"],
  ]) {
    service.registerWaterPoint({ waterPointId: id, name });
  }
  service.ingestReport({
    reportId: "a-strong",
    waterPointId: "wp-a",
    observerType: "ranger",
    observedAt: "2026-09-14T05:00:00+08:00",
    receivedAt: "2026-09-14T05:30:00+08:00",
    flowLevel: "strong",
  });
  service.ingestReport({
    reportId: "b-dry",
    waterPointId: "wp-b",
    observerType: "ranger",
    observedAt: "2026-09-13T05:00:00+08:00",
    receivedAt: "2026-09-13T06:00:00+08:00",
    flowLevel: "dry",
    note: "泉眼断流",
  });
  service.ingestReport({
    reportId: "c-usable",
    waterPointId: "wp-c",
    observerType: "lodging-host",
    observedAt: "2026-09-13T05:00:00+08:00",
    receivedAt: "2026-09-13T08:00:00+08:00",
    flowLevel: "usable",
  });

  const tripInput = {
    startAt: "2026-09-14T06:00:00+08:00",
    partySize: 4,
    legs: [
      { toWaterPointId: "wp-a", durationHours: 1 },
      { toWaterPointId: "wp-b", durationHours: 5 },
      { toWaterPointId: "wp-c", durationHours: 6 },
    ],
  };
  const beforePlan = service.plan(tripInput);
  const beforeAssess = service.assess("wp-b", "2026-09-14T12:00:00+08:00");
  const hashBefore = h.store.stateHash();

  const restarted = h.restart();
  assert.equal(restarted.store.stateHash(), hashBefore);
  assert.equal(restarted.store.seq, 6);

  const afterPlan = restarted.service.plan(tripInput);
  assert.deepEqual(afterPlan, beforePlan);
  assert.deepEqual(
    restarted.service.assess("wp-b", "2026-09-14T12:00:00+08:00"),
    beforeAssess,
  );

  // 关键推导数字
  assert.equal(afterPlan.summary.riskLegCount, 1);
  assert.equal(afterPlan.riskLegs[0].toWaterPointId, "wp-b");
  assert.equal(afterPlan.riskLegs[0].code, "dry");
  // A 可补满后，B→C 段必须背 5+6 小时、含 25% 安全余量的水
  const bc = afterPlan.segments.find((s) => s.legIndexes.includes(1) && s.legIndexes.includes(2));
  assert.equal(bc.demandLiters, 22); // 4 人 × 11h × 0.5L
  assert.equal(bc.recommendedCarryLiters, 27.5);
  assert.equal(bc.safetyMarginLiters, 5.5);
  assert.equal(afterPlan.summary.maxRecommendedCarryLiters, 27.5);

  h.cleanup();
});
