import { resolve } from "node:path";
import { EventStore } from "./store/event-store.js";
import { createService } from "./domain/service.js";
import { createHttpServer } from "./http/server.js";

const dataFile = process.env.WATER_DATA_FILE
  ? resolve(process.env.WATER_DATA_FILE)
  : resolve("data/water-events.log");
const port = Number(process.env.PORT ?? 8080);

const store = new EventStore(dataFile).open();
const service = createService(store);
const server = createHttpServer(service);

server.listen(port, () => {
  const actualPort = server.address().port;
  console.log(JSON.stringify({ msg: "water-intel api listening", port: actualPort, dataFile, ...service.meta() }));
});

function shutdown(signal) {
  server.close(() => {
    store.close();
    console.log(JSON.stringify({ msg: "shutdown complete", signal }));
    process.exit(0);
  });
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
