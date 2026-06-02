import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

function telemetryConfig(config = {}) {
  const enabled = Boolean(config.telemetry?.enabled ?? config.telemetryEnabled ?? false);
  const file = config.telemetry?.file ?? config.telemetryFile ?? "telemetry.jsonl";
  return { enabled, file };
}

function compactAction(action) {
  if (!action) return null;
  return {
    type: action.type,
    direction: action.direction,
    from: action.from,
    to: action.to,
    targetId: action.targetId,
    reason: action.reason
  };
}

export class Telemetry {
  constructor(config = {}) {
    const { enabled, file } = telemetryConfig(config);
    this.enabled = enabled;
    this.file = resolve(file);
    this.tick = 0;
    this.counters = {
      moveFailed: 0,
      pickupFailed: 0,
      putdownFailed: 0,
      replan: 0
    };

    if (this.enabled) {
      mkdirSync(dirname(this.file), { recursive: true });
    }
  }

  nextTick() {
    this.tick += 1;
    return this.tick;
  }

  count(name, amount = 1) {
    this.counters[name] = (this.counters[name] ?? 0) + amount;
  }

  record(event, payload = {}) {
    if (event === "move_failed") this.count("moveFailed");
    if (event === "pickup_failed") this.count("pickupFailed");
    if (event === "putdown_failed") this.count("putdownFailed");
    if (event === "replan") this.count("replan");

    if (!this.enabled) return;

    const entry = {
      ts: new Date().toISOString(),
      tick: this.tick,
      event,
      moveFailedCount: this.counters.moveFailed,
      pickupFailedCount: this.counters.pickupFailed,
      putdownFailedCount: this.counters.putdownFailed,
      replanCount: this.counters.replan,
      ...payload,
      action: compactAction(payload.action)
    };

    appendFileSync(this.file, `${JSON.stringify(entry)}\n`, "utf8");
  }
}

export function createTelemetry(config = {}) {
  return new Telemetry(config);
}
