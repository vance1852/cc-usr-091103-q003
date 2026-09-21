# 山野水点补给服务

长线徒步沿线的泉眼、水龙头和季节性溪流以稳定水点编号管理。本仓库在既有的**观测协议层**之上，提供可独立运行的 Node.js 后端：

- 打开一个水点，先看到**此刻是否值得依赖**、结论**何时衰减**、支持与反对它的**原始观测**；
- 输入队伍人数、出发时刻与各路段实际耗时，得到**补水缺口段**、风险等级与**应携带的安全余量**；
- 官方封闭有独立生效区间；撤回误报只能追加说明；护林员、客栈、徒步者相互冲突的报告**加权共存，不按到达先后覆盖**；
- 全部判断基于只追加事件日志持久化，进程重启后重查同一行程得到**相同的风险段与推导依据**。

零第三方依赖，Node.js >= 20。

## 运行

```bash
npm start                      # 默认 http://localhost:3000，数据目录 ./data
node src/server.js --port 8080 --data-dir /var/lib/water
npm test                       # 14 项测试（领域规则 + HTTP 全链路 + 重启复现）
```

## 协议边界（接入层）

`src/water-report.js` 的 `readWaterReport` 仍是观测报告的唯一校验入口：必填 `reportId / waterPointId / observerType / observedAt / receivedAt`（非空字符串）与枚举 `flowLevel`（`dry | trickle | usable | strong`）。契约外字段（`evidenceDigest`、照片、坐标、流量实测值……）一律进入 `details` 原样落盘，不丢弃、不改名。所有时刻必须显式携带时区（`Z` 或 `+08:00`）。

## 结论模型（打开水点时看到什么）

`GET /water-points/:id/assessment?at=<ISO时刻>`（`at` 缺省为服务器当前时刻）：

- `status`：
  - `reliable` 在期证据支持抵达时可放心补水；
  - `unreliable` 在期证据以断流/细流为主；
  - `conflicting` 支持与反对的加权质量相当——保守规划下**不**计入确定性补给；
  - `unknown` 没有在期证据（从未上报或证据均已过期）；
  - `closed` 抵达时刻落在官方封闭区间内（观测证据仍照常展示）。
- `reliability`：支持质量 / 总质量（0–1）。
- `decaysAt`：仍在参与加权的证据中，最早的时效终点——结论从这一刻起开始衰减。
- `nextStatusChangeAt`：不新增任何事件的前提下，结论下一次实际翻转的时刻（证据到期或封闭区间边界）。
- `supportingEvidence` / `opposingEvidence`：按当期权重排序的正反两造，含来源、观测时刻、流量等级、证据摘要与备注。
- `staleEvidence`：已过期或来自“未来”的证据，不参与加权但完整保留（两周前的“水量充足”就在这里）。
- `retractedEvidence`：被撤回的报告，连同撤回理由一起列出。
- `evidence`：全部未撤回证据按**确定顺序** `(observedAt, reportId)` 排列。

加权规则：来源基准可信度 护林员 1.0 > 客栈 0.8 > 徒步者 0.5（未知来源 0.3）；流量分值 strong 1 / usable 0.7 / trickle 0.35 / dry 0；权重随观测年龄在来源时效窗口（护林员 3 天、客栈 4 天、徒步者 2 天）内线性衰减。任何报告都不覆盖另一报告。

撤回在 `receivedAt` 时刻生效：评估早于该时刻的历史行程时，误报仍参与（行政撤回不追溯改写历史判断）。

## 行程推导

`POST /routes/:routeId/trip-assessments`

```json
{
  "partySize": 4,
  "startAt": "2026-09-22T06:00:00+08:00",
  "litersPerPersonHour": 0.5,
  "reserveRatio": 0.25,
  "longGapWarnMinutes": 360,
  "legDurations": { "l1": 240, "l2": 360 }
}
```

按路段耗时推算每个节点的计划抵达时刻，并在**该时刻**评估绑定水点（封闭区间与证据时效都按抵达时刻求值）。路线被切分为若干补水段：从当前位置走到下一个 `reliable` 水点为一段；段内 `closed / unreliable / conflicting / unknown` 水点逐一列出原因。每段给出：

- `durationMinutes`、`waterNeedLiters`（人数 × 时长 × 人均耗水）、`reserveLiters`（安全余量）、`carryRequiredLiters`（应携带量）；
- `risk`：`ok` / `caution`（段偏长或途中断流、封闭）/ `critical`（走到段末仍无可靠水源）；
- `summary.maxCarryRequiredLiters`：全程峰值携水要求。

评估是**内容寻址**的：ID 由 路线 + 行程输入 + 当前证据指纹 派生。证据不变时任何时候（含重启后）重放同一请求都命中同一 ID、返回逐字节一致的结果；新证据到来后同参数生成新评估，旧评估永久保留，可 `GET /trip-assessments/:id` 审计。

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST/GET | `/water-points` | 注册/列出水点（位置与未知字段原样保存），同 ID 同负载幂等 |
| GET | `/water-points/:id` | 水点实体 |
| GET | `/water-points/:id/assessment?at=` | 此刻（或指定时刻）是否值得依赖 |
| POST/GET | `/water-points/:id/observations` | 提交/列出观测；相同 `reportId` 重传幂等，负载冲突返回 409 |
| POST/GET | `/water-points/:id/retractions` | 追加撤回说明（引用原报告，不改写内容） |
| POST/GET | `/water-points/:id/closures` | 官方封闭区间 `[effectiveFrom, effectiveTo)`，`effectiveTo` 可空 |
| POST/GET | `/routes`，`GET /routes/:id` | 线性链路线（节点 + 路段基准耗时） |
| POST | `/routes/:id/trip-assessments` | 行程缺口与携水量推导 |
| GET | `/trip-assessments/:id`，`GET /trip-assessments` | 取历史评估 / 列评估摘要 |

## 持久化与并发

- 所有变更（水点、观测、撤回、封闭、路线、评估冻结）都是 `data/events.log` 中不可变的一行 JSON，追加后 `fsync`；写入全局串行化。
- 每 50 个事件生成原子替换的 `data/snapshot.json`；启动时载入快照并重放其后的日志。
- 业务幂等键去重：相同负载重传返回 `200 {meta:{deduplicated:true}}` 且不产生事件；同 ID 不同负载返回 **409**，绝不静默覆盖。
- 证据的规范顺序只由 `(observedAt, reportId)` 决定，与 `receivedAt`、写入先后无关，迟到报告不重排既有证据。
- 日志末行如因 fsync 前崩溃残缺（调用方从未收到成功响应），启动时截除；中间任何行损坏则拒绝启动。

## 目录

```
src/water-report.js        既有观测协议（接入边界，未改动）
src/domain/time.js         时刻解析（强制时区）
src/domain/waterpoint.js   水点实体
src/domain/observation.js  观测接入/撤回（复用协议校验）
src/domain/closure.js      官方封闭区间
src/domain/assessment.js   结论引擎（加权、衰减、正反证据）
src/domain/route.js        路线与行程输入
src/domain/planner.js      补水缺口与携水量推导
src/store/event-store.js   事件日志、快照、幂等、重放
src/http/api.js            JSON API
src/server.js              启动入口
test/                      协议测试（原有）+ 领域测试 + HTTP 全链路测试
fixtures/                  协议样例
```

协议层（`src/water-report.js`）不判断水点当前是否可靠，也不计算队伍用水量——这些职责全部位于其上的领域层。
