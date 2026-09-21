# 山野水点观测协议与补给判断服务

长线徒步沿线的泉眼、水龙头和季节性溪流以稳定水点编号管理。每次观测独立保存来源、观测时刻、流量等级与证据摘要，撤回只引用原观测，不覆盖其内容。

仓库中的 `fixtures/water-report.json` 是旅店经营者提交的样例，`src/water-report.js` 定义最小校验入口（接入边界），`test/water-report.test.js` 说明扩展字段的保留方式。

本仓库在协议层之上提供一个**可独立运行的 Node.js 后端**：打开水点先看到此刻是否值得依赖、结论何时衰减、支持与反对它的原始观测；再输入队伍人数与各路段耗时，得到补水缺口与安全携带余量。

## 运行

```bash
node --version          # 需要 Node.js >= 20
npm test                # 全部测试（含重启一致性、HTTP 端到端）
npm start               # 默认监听 :8080，事件日志在 data/water-events.log
PORT=9000 WATER_DATA_FILE=/srv/data/water.log npm start
```

无任何第三方依赖，仅使用 Node 内置模块。

## 为什么结论不会丢、不会变

- **只追加事件日志**（`src/store/event-store.js`）：水点注册、报告摄入、撤回追加、封闭通告各为一条事件，每行一个 JSON、连续序号，写入即 `fsync`。
- **状态只由重放得到**：进程启动时从头重放日志构建内存投影（`src/domain/projection.js`），判断结果不入库。
- **判定是纯函数**（`src/domain/assessment.js`、`src/domain/trip.js`）：结论只取决于（事件日志, 水点, 查询时刻），不读进程当前时钟（行程时间由 `startAt` 与路段耗时推导）。
- 响应中的 `meta.stateHash` 是日志字节序列的 SHA-256，`meta.seq` 是事件数，`constantsVersion` 是判定口径版本。三者相同，任何人重查都应得到逐字节相同的结论与依据。

## 证据规则

- 流量四档（协议契约）：`dry` / `trickle`（细流）/ `usable` / `strong`。
- **确定顺序只按观测时刻 `observedAt` 升序，`reportId` 兜底**；与收到时刻 `receivedAt`、入库序号无关。迟到报告插入正确位置，重传不改变顺序。
- 每条证据有有效时长 TTL（干 72h / 细流 48h / 可用 96h / 充沛 168h，水点可注册自定义 `ttlHours`）。超期证据保留但权重为 0；`conclusionExpiresAt` 是当前结论最早开始衰减的时刻。
- 来源权重：护林员/官方 3，客栈等在地观察者 2，徒步者 1（未知来源按 1）。新鲜度在 TTL 内线性折减。权重 = 来源权重 × 新鲜度。
- 对立两方次强证据达到最强方 60% 即判 `contested`（有争议），**不按到达先后覆盖任何一条**，正反原始观测同时返回。
- 水点状态：`reliable` / `marginal`（细流）/ `contested` / `unreliable`（断流）/ `unknown`（无新鲜证据）/ `closed`（官方封闭生效区间内，压过一切）。
- **撤回是追加说明**：原报告内容与顺序永不改变，撤回后该证据权重归零；一条报告可追加多条撤回说明。
- 封闭区间为半开 `[startAt, endAt)`；不传 `endAt` 表示无限期。只在区间内显示 `closed`，并预告 `nextClosure`。
- 报告的位置、观测时刻、来源、证据摘要及一切未知属性随 `details` 原样落盘返回。

## API

所有时间字段使用 ISO 8601（建议带时区偏移）。错误统一为 `{ "error": { "code", "message" } }`。

### 注册水点
`POST /api/water-points`
```json
{ "waterPointId": "spring-204", "name": "北坡204泉",
  "location": { "lat": 31.2, "lon": 103.4, "altitude": 3200 },
  "ttlHours": 48 }
```
报告可以先于注册到达（自动建占位点，稍后注册补全资料）。

### 摄入观测报告
`POST /api/reports` — 体即协议契约（`src/water-report.js` 校验），额外字段全部保留。
- 相同 `reportId` 重传且内容一致：`200 { duplicated: true }`，不追加事件、`stateHash` 不变（字段书写顺序不同也算相同）。
- 相同 `reportId` 内容不同：`409` 拒绝，更正只能走撤回，不能覆盖。

### 追加撤回说明
`POST /api/reports/:reportId/retractions`
```json
{ "reason": "定位错误，断流的是相邻岔沟", "source": "ranger-station-7", "note": "可选" }
```

### 发布官方封闭
`POST /api/closures`
```json
{ "closureId": "closure-autumn-3", "waterPointId": "spring-204",
  "startAt": "2026-09-15T00:00:00+08:00", "endAt": "2026-09-20T00:00:00+08:00",
  "reason": "上游施工封路", "issuedBy": "林管局" }
```

### 查看单个水点（打开水点第一眼看到的内容）
`GET /api/water-points/:id?asOf=2026-09-14T08:00:00%2B08:00`（`asOf` 省略则取当前时刻）

返回：当前 `status`、`verdict`（含决定性证据 id）、`conclusionExpiresAt`、生效封闭与即将生效封闭、`evidence.supporting`（usable/strong）/ `evidence.caution`（trickle）/ `evidence.opposing`（dry）三组原始观测，每条含权重、TTL、撤回说明、`receivedAt − observedAt` 的延迟等推导依据。

### 水点列表
`GET /api/water-points?asOf=...`

### 行程补水缺口规划
`POST /api/trips/plan`
```json
{ "startAt": "2026-09-14T08:00:00+08:00",
  "partySize": 4,
  "perPersonCarryCapacityLiters": 6,
  "legs": [ { "toWaterPointId": "camp-spring", "durationHours": 2 },
            { "toWaterPointId": "pass-spring", "durationHours": 6 } ] }
```
- 每个路段到达时刻按累计耗时推导，使用该时刻的水点判定。
- `riskLegs`：断流 / 细流 / 争议 / 无新鲜证据 / 封闭的路段及证据 id。
- `segments`：以"可保证补满"的水点切段，给出每段的实际需求、**安全余量**与段首必须背出的 `recommendedCarryLiters`（默认 0.5 L/人·小时 × 安全系数 1.25）；`optimisticCarryLiters` 仅在假设细流/争议点能补一半时成立，不计入安全口径；携带容量装不下时 `exceedsCarryCapacity: true`。
- 饮水速率、安全系数等可用 `perPersonLitersPerHour`、`safetyFactor`、`marginalRefillFactor` 覆盖。

### 其他
`GET /health`、`GET /api/meta`：事件序号、状态哈希、口径版本与计数。

协议层（`src/water-report.js`）本身仍不判断水点当前是否可靠，也不计算队伍用水量；这些能力全部位于其上层。
