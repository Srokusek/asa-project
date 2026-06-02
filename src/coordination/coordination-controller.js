import { createTeamMessage, TEAM_MESSAGE_TYPES } from "../communication/team-protocol.js";
import { MISSION_TYPES } from "../missions/mission-spec.js";

export const COORDINATION_STATES = Object.freeze({
  RECEIVED: "RECEIVED",
  EVALUATING: "EVALUATING",
  ACCEPTED: "ACCEPTED",
  ASSIGNED: "ASSIGNED",
  EXECUTING_PHASE: "EXECUTING_PHASE",
  WAITING_TEAMMATE: "WAITING_TEAMMATE",
  READY: "READY",
  CONFIRMING: "CONFIRMING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  ABORTED: "ABORTED"
});

function targetFrom(value) {
  const target = value?.target ?? value?.position ?? value?.goal?.target ?? value?.goal?.position;
  if (!target) return null;
  const x = Math.round(Number(target.x));
  const y = Math.round(Number(target.y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function distance(a, b) {
  return Math.abs(Math.round(Number(a?.x ?? 0)) - Math.round(Number(b?.x ?? 0))) +
    Math.abs(Math.round(Number(a?.y ?? 0)) - Math.round(Number(b?.y ?? 0)));
}

export class CoordinationController {
  constructor({ agentId, beliefs, missionRegistry = null, sendTeamMessage = null } = {}) {
    this.agentId = agentId;
    this.beliefs = beliefs;
    this.missionRegistry = missionRegistry;
    this.sendTeamMessage = sendTeamMessage;
    this.plans = new Map();
    this.redLight = false;
    this.redLightReason = null;
    this.outbox = [];
  }

  emit(type, payload = {}, to = null, ttl = 20) {
    const message = createTeamMessage(type, this.agentId, to, payload, {
      tick: this.beliefs?.time ?? 0,
      ttl
    });
    this.outbox.push(message);
    this.sendTeamMessage?.(message);
    return message;
  }

  drainOutbox() {
    const messages = this.outbox;
    this.outbox = [];
    return messages;
  }

  movementBlocked(action = null) {
    if (!this.redLight) return false;
    if (!action || action.type !== "move") return false;
    return true;
  }

  receiveTeamMessage(message) {
    if (!message) return null;
    if (message.type === TEAM_MESSAGE_TYPES.RED_LIGHT) {
      this.redLight = true;
      this.redLightReason = message.payload?.reason ?? "red_light";
      this.emit(TEAM_MESSAGE_TYPES.STATUS_UPDATE, { status: "RED_LIGHT_ACTIVE", reason: this.redLightReason }, message.from);
      return { accepted: true, type: message.type };
    }
    if (message.type === TEAM_MESSAGE_TYPES.GREEN_LIGHT || message.type === TEAM_MESSAGE_TYPES.RESUME) {
      this.redLight = false;
      this.redLightReason = null;
      this.emit(TEAM_MESSAGE_TYPES.STATUS_UPDATE, { status: "GREEN_LIGHT_ACTIVE" }, message.from);
      return { accepted: true, type: message.type };
    }
    if (message.type === TEAM_MESSAGE_TYPES.COORDINATION_PLAN) {
      return this.receiveCoordinationPlan(message.payload?.coordinationPlan ?? message.payload, message.from);
    }
    if (message.type === TEAM_MESSAGE_TYPES.SUBGOAL_ASSIGNMENT) {
      return this.receiveSubgoal(message.payload?.subgoal ?? message.payload, message.from);
    }
    if (message.type === TEAM_MESSAGE_TYPES.HANDOFF_REQUEST) {
      return this.failHandoff(message.payload, message.from);
    }
    return null;
  }

  receiveCoordinationPlan(plan, from = null) {
    if (!plan || typeof plan !== "object") return { accepted: false, reason: "invalid_coordination_plan" };
    const role = plan.roles?.[this.agentId] ?? plan.roles?.bdiAgent ?? plan.roles?.["bdi-agent"] ?? null;
    if (!role && plan.assignedTo && String(plan.assignedTo) !== String(this.agentId)) {
      return { accepted: false, reason: "not_assigned" };
    }
    const id = String(plan.id ?? plan.missionId ?? `coord_${Date.now()}`);
    const entry = {
      id,
      plan,
      from,
      state: COORDINATION_STATES.ACCEPTED,
      role,
      createdAtTick: this.beliefs?.time ?? 0,
      currentPhase: plan.phases?.[0]?.id ?? null
    };
    this.plans.set(id, entry);
    this.emit(TEAM_MESSAGE_TYPES.MISSION_ACCEPTED, { missionId: plan.missionId ?? id, coordinationPlanId: id }, from);
    this.applyPlanRole(entry);
    return { accepted: true, planId: id, state: entry.state };
  }

  receiveSubgoal(subgoal, from = null) {
    if (!subgoal || typeof subgoal !== "object") return { accepted: false, reason: "invalid_subgoal" };
    const type = String(subgoal.type ?? subgoal.kind ?? "").toUpperCase();
    if ([MISSION_TYPES.RENDEZVOUS, MISSION_TYPES.BOTH_NEAR_POSITION].includes(type)) {
      const target = targetFrom(subgoal);
      if (!target) return { accepted: false, reason: "missing_target" };
      const task = this.beliefs?.pushManualTask?.({
        type: "goto_tile",
        sourceChatId: null,
        senderId: from,
        expiresTicks: Number(subgoal.expiresTicks ?? 80),
        priority: "sticky_until_done",
        payload: {
          target,
          reason: "coordination_rendezvous",
          goalType: "goto_tile",
          coordination: true,
          missionId: subgoal.missionId ?? null
        }
      });
      this.emit(TEAM_MESSAGE_TYPES.RENDEZVOUS_ACK, { missionId: subgoal.missionId ?? null, target, taskId: task?.id ?? null }, from);
      return { accepted: true, task, target };
    }
    if (type === MISSION_TYPES.HANDOFF) {
      return this.failHandoff(subgoal, from);
    }
    return { accepted: false, reason: "unsupported_subgoal" };
  }

  applyPlanRole(entry) {
    const plan = entry.plan;
    if ([MISSION_TYPES.RENDEZVOUS, MISSION_TYPES.BOTH_NEAR_POSITION].includes(plan.type)) {
      const target = targetFrom(entry.role ?? plan);
      if (target) {
        this.receiveSubgoal({ type: plan.type, target, missionId: plan.missionId }, entry.from);
        entry.state = COORDINATION_STATES.EXECUTING_PHASE;
      }
    } else if (plan.type === MISSION_TYPES.HANDOFF) {
      this.failHandoff(plan, entry.from);
      entry.state = COORDINATION_STATES.FAILED;
    } else {
      entry.state = COORDINATION_STATES.ASSIGNED;
    }
  }

  failHandoff(payload = {}, to = null) {
    const missionId = payload?.missionId ?? payload?.id ?? null;
    if (missionId) this.missionRegistry?.markFailed?.(missionId, "handoff_not_supported_by_environment");
    this.emit(TEAM_MESSAGE_TYPES.MISSION_FAILED, {
      missionId,
      reason: "handoff_not_supported_by_environment"
    }, to);
    return { accepted: false, reason: "handoff_not_supported_by_environment" };
  }

  update() {
    if (!this.beliefs?.me) return [];
    const readyMessages = [];
    for (const entry of this.plans.values()) {
      if (entry.state !== COORDINATION_STATES.EXECUTING_PHASE) continue;
      const target = targetFrom(entry.role ?? entry.plan);
      const maxDistance = Number(entry.role?.maxDistance ?? entry.plan?.goal?.maxDistance ?? 0);
      if (target && distance(this.beliefs.me, target) <= maxDistance) {
        entry.state = COORDINATION_STATES.READY;
        readyMessages.push(this.emit(TEAM_MESSAGE_TYPES.RENDEZVOUS_READY, {
          missionId: entry.plan.missionId ?? entry.id,
          coordinationPlanId: entry.id,
          target,
          position: { x: this.beliefs.me.x, y: this.beliefs.me.y }
        }, entry.from));
      }
    }
    return readyMessages;
  }
}
