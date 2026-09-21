import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  writeSync,
  fsyncSync,
  readFileSync,
} from "node:fs";
import { dirname } from "node:path";

// 只追加（append-only）事件日志：每条事件一行 JSON，写入后 fsync。
// 结论不入库——状态全部由事件重放得到，进程重启后判断可逐字节恢复。
export class EventStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.events = [];
    this.hash = createHash("sha256");
    this.fd = null;
  }

  open() {
    mkdirSync(dirname(this.filePath), { recursive: true });
    if (existsSync(this.filePath)) {
      const text = readFileSync(this.filePath, "utf8");
      let expectedSeq = 1;
      for (const rawLine of text.split("\n")) {
        if (!rawLine.length) continue;
        let event;
        try {
          event = JSON.parse(rawLine);
        } catch (err) {
          throw new Error(`事件日志损坏，无法解析第 ${expectedSeq} 行: ${err.message}`);
        }
        if (event.seq !== expectedSeq) {
          throw new Error(`事件日志序号不连续: 期望 ${expectedSeq}，实际 ${event.seq}`);
        }
        this.events.push(event);
        this.hash.update(rawLine + "\n", "utf8");
        expectedSeq += 1;
      }
    }
    this.fd = openSync(this.filePath, "a");
    return this;
  }

  get seq() {
    return this.events.length;
  }

  // 重放与追加走同一字节序列，任何时刻拿到的摘要都一致
  stateHash() {
    return this.hash.copy().digest("hex");
  }

  append(type, payload) {
    const event = {
      seq: this.events.length + 1,
      type,
      recordedAt: new Date().toISOString(),
      payload,
    };
    const line = JSON.stringify(event) + "\n";
    writeSync(this.fd, line);
    fsyncSync(this.fd);
    this.hash.update(line, "utf8");
    this.events.push(event);
    return event;
  }

  close() {
    if (this.fd !== null) {
      fsyncSync(this.fd);
      closeSync(this.fd);
      this.fd = null;
    }
  }
}
