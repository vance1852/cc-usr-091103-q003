import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readWaterReport } from "../src/water-report.js";

test("解析水点报告并保留证据摘要", async () => {
  const report = readWaterReport(JSON.parse(await readFile(new URL("../fixtures/water-report.json", import.meta.url), "utf8")));
  assert.equal(report.flowLevel, "trickle");
  assert.match(report.details.evidenceDigest, /^sha256:/);
});

test("不接受协议以外的流量等级", () => {
  assert.throws(() => readWaterReport({ reportId: "r", waterPointId: "w", observerType: "hiker", observedAt: "t", receivedAt: "t", flowLevel: "unknown" }));
});
