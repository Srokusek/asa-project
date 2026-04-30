import { setTimeout as sleep } from "node:timers/promises";

export class Executor {
  constructor(socket, beliefs, config) {
    this.socket = socket;
    this.beliefs = beliefs;
    this.config = config;
    this.busy = false;
  }

  async execute(action) {
    if (!action || this.busy) return false;
    this.busy = true;
    try {
      if (action.type === "move") return await this.move(action.direction);
      if (action.type === "pick_up") return await this.pickUp();
      if (action.type === "put_down") return await this.putDown(action.parcels === "all" ? undefined : action.parcels);
      this.beliefs.pushEvent("UNKNOWN_ACTION", { action });
      return false;
    } finally {
      this.busy = false;
      if (this.config.actionDelayMs > 0) {
        await sleep(this.config.actionDelayMs);
      }
    }
  }

  async move(direction) {
    try {
      const result = await this.socket.emitMove(direction);
      if (result === false) {
        this.beliefs.pushEvent("MOVE_FAILED", { direction });
        this.beliefs.pushEvent("PATH_BLOCKED", { direction });
        return false;
      }

      if (result && this.beliefs.me) {
        this.beliefs.updateSelf({ ...this.beliefs.me, x: result.x, y: result.y });
      }
      return result;
    } catch (error) {
      this.beliefs.pushEvent("MOVE_FAILED", { direction, error: error.message });
      this.beliefs.pushEvent("PATH_BLOCKED", { direction, error: error.message });
      return false;
    }
  }

  async pickUp() {
    try {
      const result = await this.socket.emitPickup();
      if (Array.isArray(result) && result.length > 0) {
        for (const picked of result) {
          const parcel = this.beliefs.parcels.get(picked.id);
          if (parcel) {
            const rewardNow = this.beliefs.estimateParcelReward(parcel);
            this.beliefs.carriedParcels.set(picked.id, {
              id: picked.id,
              valueAtPickup: rewardNow,
              pickupTime: this.beliefs.time,
              decayRate: this.config.planner.decayRate,
              confidence: parcel.confidence,
              x: parcel.x,
              y: parcel.y
            });
            parcel.carriedBy = this.beliefs.me?.id ?? "me";
            parcel.confidence = 0;
          }
        }
        this.beliefs.pushEvent("PICK_PACKAGE", { parcels: result });
        return result;
      }

      this.beliefs.pushEvent("TARGET_NOT_FOUND", { action: "pick_up" });
      this.beliefs.pushEvent("PICKUP_FAILED", { reason: "empty_pickup" });
      return false;
    } catch (error) {
      this.beliefs.pushEvent("PICKUP_FAILED", { error: error.message });
      return false;
    }
  }

  async putDown(selected) {
    try {
      const result = selected ? await this.socket.emitPutdown(selected) : await this.socket.emitPutdown();
      if (Array.isArray(result) && result.length > 0) {
        for (const delivered of result) {
          this.beliefs.parcels.delete(delivered.id);
          this.beliefs.carriedParcels.delete(delivered.id);
        }
        this.beliefs.pushEvent("DELIVER_PACKAGES", { parcels: result });
        return result;
      }

      this.beliefs.pushEvent("PUTDOWN_FAILED", { reason: "empty_putdown" });
      return false;
    } catch (error) {
      this.beliefs.pushEvent("PUTDOWN_FAILED", { error: error.message });
      return false;
    }
  }
}
