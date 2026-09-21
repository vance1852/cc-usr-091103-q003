import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../src/store/event-store.js";
import { createService } from "../src/domain/service.js";

export function makeHarness() {
  const dir = mkdtempSync(join(tmpdir(), "water-intel-"));
  const file = join(dir, "events.log");
  const bootstrap = () => {
    const store = new EventStore(file).open();
    const service = createService(store);
    return { store, service };
  };
  const first = bootstrap();
  return {
    dir,
    file,
    store: first.store,
    service: first.service,
    // 模拟进程重启：重新打开同一只追加日志并重放
    restart() {
      this.store.close();
      const next = bootstrap();
      this.store = next.store;
      this.service = next.service;
      return next;
    },
    cleanup() {
      this.store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
