#!/usr/bin/env node
// 可独立运行的后端：node src/server.js [--port 3000] [--data-dir ./data]
import { EventStore } from "./store/event-store.js";
import { createApp } from "./http/api.js";

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return process.env[name.toUpperCase().replace(/-/g, "_")] ?? fallback;
  return args[i + 1];
}

const port = Number(flag("port", "3000"));
const dataDir = flag("data-dir", "./data");

const store = new EventStore(dataDir);
await store.recover();

const server = createApp(store);
server.listen(port, () => {
  console.log(`山野水点补给服务已启动: http://localhost:${port}（数据目录 ${dataDir}）`);
});

const shutdown = async () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
