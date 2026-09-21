import { createServer } from "node:http";
import { DomainError } from "../errors.js";

const MAX_BODY_BYTES = 64 * 1024;

function sendJson(res, statusCode, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new DomainError(413, "payload_too_large", "请求体超过 64KiB"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new DomainError(400, "invalid_request", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function createHttpServer(service) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const { pathname } = url;
    const method = req.method ?? "GET";

    try {
      if (method === "GET" && pathname === "/health") {
        sendJson(res, 200, { ok: true, ...service.meta() });
        return;
      }
      if (method === "GET" && pathname === "/api/meta") {
        sendJson(res, 200, service.meta());
        return;
      }
      if (method === "GET" && pathname === "/api/water-points") {
        sendJson(res, 200, service.listWaterPoints(url.searchParams.get("asOf")));
        return;
      }

      let match;
      if (method === "POST" && pathname === "/api/water-points") {
        sendJson(res, 201, service.registerWaterPoint(await readJsonBody(req)));
        return;
      }
      if (method === "POST" && pathname === "/api/reports") {
        const result = service.ingestReport(await readJsonBody(req));
        sendJson(res, result.duplicated ? 200 : 201, result);
        return;
      }
      if ((match = pathname.match(/^\/api\/reports\/([^/]+)\/retractions$/)) && method === "POST") {
        const body = await readJsonBody(req);
        sendJson(res, 201, service.retractReport({ ...body, reportId: decodeURIComponent(match[1]) }));
        return;
      }
      if (method === "POST" && pathname === "/api/closures") {
        sendJson(res, 201, service.issueClosure(await readJsonBody(req)));
        return;
      }
      if ((match = pathname.match(/^\/api\/water-points\/([^/]+)$/)) && method === "GET") {
        sendJson(res, 200, service.assess(decodeURIComponent(match[1]), url.searchParams.get("asOf")));
        return;
      }
      if (method === "POST" && pathname === "/api/trips/plan") {
        sendJson(res, 200, service.plan(await readJsonBody(req)));
        return;
      }

      sendJson(res, 404, { error: { code: "not_found", message: `没有这条路由: ${method} ${pathname}` } });
    } catch (err) {
      if (err instanceof DomainError) {
        sendJson(res, err.statusCode, { error: { code: err.code, message: err.message } });
      } else {
        sendJson(res, 500, { error: { code: "internal_error", message: err.message } });
      }
    }
  });
}
