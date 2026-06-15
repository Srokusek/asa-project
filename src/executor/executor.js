export class Executor {
  constructor(socket, beliefs, config, telemetry = null) {
    this.socket = socket;
    this.beliefs = beliefs;
    this.config = config;
    this.telemetry = telemetry;
    this.busy = false;
  }

  async execute(action) {
    if (!action || this.busy) return false;
    this.busy = true;
    try {
      if (action.type === "move") return await this.move(action);
      if (action.type === "pick_up") return await this.pickUp(action);
      if (action.type === "put_down") return await this.putDown(action.parcels === "all" ? undefined : action.parcels);
      if (action.type === "write_message" || action.type === "say" || action.type === "shout") {
        return await this.writeMessage(action);
      }
      this.beliefs.pushEvent("UNKNOWN_ACTION", { action });
      this.telemetry?.record("unknown_action", { action, result: false });
      return false;
    } finally {
      this.busy = false;
    }
  }

  async writeMessage(action = {}) {
    const toId = action.toId ?? action.targetId ?? action.recipientId ?? null;
    const message = String(action.message ?? action.msg ?? action.text ?? "");
    const shouldShout = action.type === "shout" || action.shout === true || !toId;

    if (!message) {
      this.beliefs.pushEvent("MESSAGE_FAILED", { reason: "empty_message", action });
      this.telemetry?.record("message_failed", { action, result: false, reason: "empty_message" });
      return false;
    }

    try {
      const result = shouldShout ? await this.socket.emitShout(message) : await this.socket.emitSay(toId, message);
      this.beliefs.pushEvent("MESSAGE_SENT", { toId, message, shouted: shouldShout, result });
      this.telemetry?.record("message_sent", {
        action,
        result,
        toId,
        shouted: shouldShout
      });
      return result;
    } catch (error) {
      this.beliefs.pushEvent("MESSAGE_FAILED", { toId, message, shouted: shouldShout, error: error.message });
      this.telemetry?.record("message_failed", {
        action,
        result: false,
        toId,
        shouted: shouldShout,
        error: error.message
      });
      return false;
    }
  }

  async move(actionOrDirection) {
    const direction =
      typeof actionOrDirection === "string"
        ? actionOrDirection
        : actionOrDirection.direction;
    const blockedCell =
      actionOrDirection && typeof actionOrDirection === "object"
        ? actionOrDirection.to
        : null;
    const fromCell =
      actionOrDirection && typeof actionOrDirection === "object"
        ? actionOrDirection.from
        : this.beliefs.me
          ? { x: this.beliefs.me.x, y: this.beliefs.me.y }
          : null;
    const edgeBlocksEnabled = this.config.planner.enableEdgeTemporaryBlocks !== false;
    const edgeTtl = Number(this.config.planner.temporaryEdgeBlockTtlTicks ?? 2);

    try {
      const result = await this.socket.emitMove(direction);
      if (result === false) {
        this.beliefs.pushEvent("MOVE_FAILED", { direction, blockedCell });
        this.beliefs.pushEvent("PATH_BLOCKED", { direction, blockedCell });
        if (edgeBlocksEnabled && fromCell && blockedCell) {
          this.beliefs.markTemporaryBlockedEdge(fromCell, blockedCell, edgeTtl, "move_failed");
        }
        if (blockedCell) {
          this.beliefs.markTemporaryBlocked(blockedCell, 3, "move_failed");
        }
        this.telemetry?.record("move_failed", {
          action: actionOrDirection,
          result: false,
          currentPosition: this.beliefs.me ? { x: this.beliefs.me.x, y: this.beliefs.me.y } : null,
          temporaryBlockedCells: this.beliefs.temporaryBlockedCells?.size ?? 0
        });
        return false;
      }

      if (result && this.beliefs.me) {
        this.beliefs.updateSelf({ ...this.beliefs.me, x: result.x, y: result.y });
      }
      this.telemetry?.record("move", {
        action: actionOrDirection,
        result,
        currentPosition: result
      });
      return result;
    } catch (error) {
      this.beliefs.pushEvent("MOVE_FAILED", { direction, blockedCell, error: error.message });
      this.beliefs.pushEvent("PATH_BLOCKED", { direction, blockedCell, error: error.message });
      if (edgeBlocksEnabled && fromCell && blockedCell) {
        this.beliefs.markTemporaryBlockedEdge(fromCell, blockedCell, edgeTtl, "move_failed_error");
      }
      if (blockedCell) {
        this.beliefs.markTemporaryBlocked(blockedCell, 3, "move_failed_error");
      }
      this.telemetry?.record("move_failed", {
        action: actionOrDirection,
        result: false,
        error: error.message,
        temporaryBlockedCells: this.beliefs.temporaryBlockedCells?.size ?? 0
      });
      return false;
    }
  }

  async pickUp(action = null) {
    try {
      const result = await this.socket.emitPickup();
      if (Array.isArray(result) && result.length > 0) {
        for (const picked of result) {
          const parcel = this.beliefs.parcels.get(picked.id);
          const fallbackValue = Number(this.config.planner.meanPackageValue ?? 0);
          const serverReward = Number(picked.reward ?? picked.value ?? fallbackValue);
          const pickedReward = Number.isFinite(serverReward) ? serverReward : fallbackValue;
          const pickupPosition = {
            x: parcel?.x ?? action?.at?.x ?? this.beliefs.me?.x,
            y: parcel?.y ?? action?.at?.y ?? this.beliefs.me?.y
          };
          const pickupMultiplierAtPickup = this.beliefs.pickupMultiplierAt?.(pickupPosition) ?? 1;
          const pickupBonusAtPickup = this.beliefs.pickupBonusAt?.(pickupPosition) ?? 0;
          if (parcel) {
            const rewardNow = Number.isFinite(Number(picked.reward ?? picked.value))
              ? pickedReward
              : this.beliefs.estimateParcelReward(parcel);
            this.beliefs.carriedParcels.set(picked.id, {
              id: picked.id,
              greenId: action?.targetId,
              pickupSourceId: `L_${Number(pickupPosition.x ?? 0)}_${Number(pickupPosition.y ?? 0)}`,
              valueAtPickup: rewardNow,
              pickupTime: this.beliefs.time,
              decayRate: this.config.planner.decayRate,
              confidence: parcel.confidence,
              pickupMultiplierAtPickup,
              pickupBonusAtPickup,
              x: parcel.x,
              y: parcel.y
            });
            parcel.carriedBy = this.beliefs.me?.id ?? "me";
            parcel.confidence = 0;
          } else {
            this.beliefs.carriedParcels.set(picked.id, {
              id: picked.id,
              greenId: action?.targetId,
              pickupSourceId: `L_${Number(pickupPosition.x ?? 0)}_${Number(pickupPosition.y ?? 0)}`,
              valueAtPickup: pickedReward,
              pickupTime: this.beliefs.time,
              decayRate: this.config.planner.decayRate,
              confidence: this.config.planner.minParcelConfidence,
              pickupMultiplierAtPickup,
              pickupBonusAtPickup,
              x: pickupPosition.x,
              y: pickupPosition.y
            });
          }
        }
        const orchestrationActivated = action?.orchestrationRuleId
          ? this.beliefs.activateOrchestrationRule?.(action.orchestrationRuleId) === true
          : false;
        this.beliefs.pushEvent("PICK_PACKAGE", {
          parcels: result,
          orchestrationRuleId: orchestrationActivated ? action.orchestrationRuleId : null,
          dropoffPoiId: orchestrationActivated ? action.dropoffPoiId ?? null : null
        });
        this.telemetry?.record("pick_up", {
          action,
          result,
          carriedCount: this.beliefs.carriedParcels.size
        });
        return result;
      }

      this.beliefs.pushEvent("TARGET_NOT_FOUND", { action: "pick_up" });
      this.beliefs.pushEvent("PICKUP_FAILED", { reason: "empty_pickup" });
      this.telemetry?.record("pickup_failed", { action, result: false, reason: "empty_pickup" });
      return false;
    } catch (error) {
      this.beliefs.pushEvent("PICKUP_FAILED", { error: error.message });
      this.telemetry?.record("pickup_failed", { action, result: false, error: error.message });
      return false;
    }
  }

  async putDown(selected) {
    try {
      const result = selected ? await this.socket.emitPutdown(selected) : await this.socket.emitPutdown();
      if (Array.isArray(result) && result.length > 0) {
        const droppedParcelIds = result.map((parcel) => String(parcel?.id ?? "")).filter(Boolean);
        for (const delivered of result) {
          this.beliefs.parcels.delete(delivered.id);
          this.beliefs.carriedParcels.delete(delivered.id);
        }
        if (this.config?.agentType === "bdi" && droppedParcelIds.length > 0) {
          this.beliefs.noteDeliveryTileDroppedParcelIds?.(droppedParcelIds);
        }
        if (this.beliefs.me) {
          this.beliefs.lastDeliveryPosition = { x: this.beliefs.me.x, y: this.beliefs.me.y };
        }
        this.beliefs.clearActiveOrchestrationRule?.("putdown_succeeded");
        this.beliefs.pushEvent("DELIVER_PACKAGES", { parcels: result });
        this.telemetry?.record("put_down", {
          action: { type: "put_down", parcels: selected ?? "all" },
          result,
          carriedCount: this.beliefs.carriedParcels.size,
          score: this.beliefs.me?.score
        });
        return result;
      }

      this.beliefs.pushEvent("PUTDOWN_FAILED", { reason: "empty_putdown" });
      this.telemetry?.record("putdown_failed", {
        action: { type: "put_down", parcels: selected ?? "all" },
        result: false,
        reason: "empty_putdown"
      });
      return false;
    } catch (error) {
      this.beliefs.pushEvent("PUTDOWN_FAILED", { error: error.message });
      this.telemetry?.record("putdown_failed", {
        action: { type: "put_down", parcels: selected ?? "all" },
        result: false,
        error: error.message
      });
      return false;
    }
  }
}
