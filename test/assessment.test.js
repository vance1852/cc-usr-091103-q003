import test from "node:test";
import assert from "node:assert/strict";
import { makeHarness } from "../test-helpers/harness.js";

test("旧的水量充足记录过期后，新断流报告应使水点判定为不可依赖，并给出衰减时刻", () => {
  const h = makeHarness();
  const { service } = h;
  service.registerWaterPoint({ waterPointId: "spring-north-204", name: "北坡 204 泉" });

  // 两周前徒步者留下“水量充足”记录
  const old = service.ingestReport({
    reportId: "hiker-old-0901",
    waterPointId: "spring-north-204",
    observerType: "hiker",
    observedAt: "2026-09-01T08:00:00+08:00",
    receivedAt: "2026-09-01T09:00:00+08:00",
    flowLevel: "strong",
    note: "水很大",
  });
  assert.equal(old.duplicated, false);

  const staleNow = service.assess("spring-north-204", "2026-09-14T08:00:00+08:00");
  assert.equal(staleNow.status, "unknown");
  assert.equal(staleNow.stale, true);
  assert.equal(staleNow.evidence.supporting[0].fresh, false);
  assert.equal(staleNow.evidence.supporting[0].weight, 0);

  // 当天护林员报告泉眼断流
  service.ingestReport({
    reportId: "ranger-0914-dry",
    waterPointId: "spring-north-204",
    observerType: "ranger",
    observedAt: "2026-09-14T06:00:00+08:00",
    receivedAt: "2026-09-14T06:40:00+08:00",
    flowLevel: "dry",
    evidenceDigest: "sha256:abc",
    note: "泉眼完全断流",
  });

  const now = service.assess("spring-north-204", "2026-09-14T08:00:00+08:00");
  assert.equal(now.status, "unreliable");
  assert.equal(now.reliable, false);
  assert.deepEqual(now.verdict.decisiveReportIds, ["ranger-0914-dry"]);
  // 断流证据按 72 小时 TTL 衰减
  assert.equal(now.conclusionExpiresAt, "2026-09-16T22:00:00.000Z");
  // 支持与反对的原始观测都保留，旧记录不被删除，只是权重为 0
  assert.equal(now.evidence.supporting[0].reportId, "hiker-old-0901");
  assert.equal(now.evidence.opposing[0].reportId, "ranger-0914-dry");
  assert.equal(now.evidence.supporting[0].weight, 0);

  h.cleanup();
});

test("撤回误报只能追加说明：原观测内容与证据顺序不变，但权重归零", () => {
  const h = makeHarness();
  const { service } = h;
  service.registerWaterPoint({ waterPointId: "wp-1" });
  service.ingestReport({
    reportId: "r1",
    waterPointId: "wp-1",
    observerType: "ranger",
    observedAt: "2026-09-14T06:00:00+08:00",
    receivedAt: "2026-09-14T06:30:00+08:00",
    flowLevel: "dry",
    note: "原始误报内容",
  });
  const before = service.assess("wp-1", "2026-09-14T08:00:00+08:00");
  assert.equal(before.status, "unreliable");

  const retraction = service.retractReport({
    reportId: "r1",
    reason: "定位错误，断流的是相邻岔沟",
    source: "ranger-station-7",
  });
  assert.equal(retraction.retractionCount, 1);
  // 允许多次追加说明
  const again = service.retractReport({ reportId: "r1", reason: "现场复核补充：已立错误标识牌" });
  assert.equal(again.retractionCount, 2);

  const after = service.assess("wp-1", "2026-09-14T08:00:00+08:00");
  assert.equal(after.status, "unknown");
  const original = after.evidence.opposing.find((e) => e.reportId === "r1");
  assert.equal(original.note, "原始误报内容"); // 原内容未被覆盖
  assert.equal(original.retracted, true);
  assert.equal(original.weight, 0);
  assert.equal(original.retractions.length, 2);
  assert.match(original.retractions[0].reason, /定位错误/);

  h.cleanup();
});

test("护林员断流与客栈细流证据冲突时判 contested，不按到达先后覆盖", () => {
  const h = makeHarness();
  const { service } = h;
  service.registerWaterPoint({ waterPointId: "wp-2" });

  // 先到：客栈说还有细流
  service.ingestReport({
    reportId: "inn-late-arrival",
    waterPointId: "wp-2",
    observerType: "lodging-host",
    observedAt: "2026-09-14T07:00:00+08:00",
    receivedAt: "2026-09-14T07:10:00+08:00",
    flowLevel: "trickle",
  });
  // 后到：护林员说断流——不能简单覆盖客栈，也不能被客栈覆盖
  service.ingestReport({
    reportId: "ranger-dry",
    waterPointId: "wp-2",
    observerType: "ranger",
    observedAt: "2026-09-14T06:00:00+08:00",
    receivedAt: "2026-09-14T09:00:00+08:00",
    flowLevel: "dry",
  });

  const a = service.assess("wp-2", "2026-09-14T10:00:00+08:00");
  assert.equal(a.status, "contested");
  assert.equal(a.verdict.contested, true);
  // 证据确定顺序按观测时刻，护林员 06:00 在前；与谁先收到无关
  const order = [...a.evidence.opposing, ...a.evidence.caution].sort(
    (x, y) => Date.parse(x.observedAt) - Date.parse(y.observedAt),
  );
  assert.deepEqual(
    [...a.evidence.opposing, ...a.evidence.caution].map((e) => e.reportId),
    order.map((e) => e.reportId),
  );

  h.cleanup();
});

test("官方封闭只在生效区间内压过其他状态", () => {
  const h = makeHarness();
  const { service } = h;
  service.registerWaterPoint({ waterPointId: "wp-3" });
  service.ingestReport({
    reportId: "r-strong",
    waterPointId: "wp-3",
    observerType: "hiker",
    observedAt: "2026-09-13T08:00:00+08:00",
    receivedAt: "2026-09-13T09:00:00+08:00",
    flowLevel: "strong",
  });
  service.issueClosure({
    closureId: "closure-autumn-3",
    waterPointId: "wp-3",
    startAt: "2026-09-15T00:00:00+08:00",
    endAt: "2026-09-20T00:00:00+08:00",
    reason: "上游施工封路",
    issuedBy: "林管局",
  });

  assert.equal(service.assess("wp-3", "2026-09-14T12:00:00+08:00").status, "reliable");
  const closed = service.assess("wp-3", "2026-09-16T12:00:00+08:00");
  assert.equal(closed.status, "closed");
  assert.equal(closed.closure.closureId, "closure-autumn-3");
  assert.equal(closed.nextClosure, null);
  // 区间结束后恢复底层判断（若证据仍新鲜）
  const after = service.assess("wp-3", "2026-09-21T00:00:00+08:00");
  assert.notEqual(after.status, "closed");
  assert.equal(after.closure, null);

  h.cleanup();
});

test("未知属性与位置、证据摘要随 details 原样保存", () => {
  const h = makeHarness();
  const { service } = h;
  service.ingestReport({
    reportId: "r-extra",
    waterPointId: "wp-x",
    observerType: "hiker",
    observedAt: "2026-09-14T06:00:00+08:00",
    receivedAt: "2026-09-14T06:30:00+08:00",
    flowLevel: "usable",
    evidenceDigest: "sha256:deadbeef",
    waterTemperatureC: 6,
    photoUrl: "https://example.test/x.jpg",
  });
  const a = service.assess("wp-x", "2026-09-14T08:00:00+08:00");
  const e = a.evidence.supporting[0];
  assert.equal(e.details.evidenceDigest, "sha256:deadbeef");
  assert.equal(e.details.waterTemperatureC, 6);
  assert.equal(e.details.photoUrl, "https://example.test/x.jpg");
  // 报告先于注册到达：占位点可评估，注册补全名称
  service.registerWaterPoint({ waterPointId: "wp-x", name: "西沟水龙头" });
  assert.equal(service.assess("wp-x", "2026-09-14T08:00:00+08:00").name, "西沟水龙头");

  h.cleanup();
});
