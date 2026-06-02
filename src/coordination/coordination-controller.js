import { createTeamMessage, TEAM_MESSAGE_TYPES } from "../communication/team-protocol.js";
import { normalizeAlias } from "../communication/message-router.js";
import { MISSION_TYPES } from "../missions/mission-spec.js";

export const COORDINATION_STATES = Object.freeze({
  RECEIVED: "RECEIVED",
  ACCEPTED: "ACCEPTED",
  EXECUTING: "EXECUTING",
  WAITING_TEAMMATE: "WAITING_TEAMMATE",
  READY: "READY",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  ABORTED: "ABORTED",
  EXECUTING_PHASE: "EXECUTING"
});

function uniqueAliases(values = []) {
  return [...new Set(values.map(normalizeAlias).filter(Boolean))];
}

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

function planId(plan = {}) {
  return String(plan.id ?? plan.missionId ?? `coord_${Date.now()}`);
}

function planType(plan = {}) {
  return String(plan.type ?? plan.kind ?? plan.phases?.[0]?.type ?? "").toUpperCase();
}

function roleType(role = {}, plan = {}) {
  return String(role.type ?? role.kind ?? role.action ?? planType(plan)).toUpperCase();
}

function roleForAliases(plan = {}, aliases = []) {
  const roles = plan.roles;
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) return null;
  const effectiveAliases = uniqueAliases(aliases);
  for (const alias of effectiveAliases) {
    if (roles[alias]) return roles[alias];
    const matchedKey = Object.keys(roles).find((key) => normalizeAlias(key) === alias);
    if (matchedKey) return roles[matchedKey];
  }
  return null;
}

function planRoleCount(plan = {}) {
  return plan.roles && typeof plan.roles === "object" && !Array.isArray(plan.roles)
    ? Object.keys(plan.roles).length
    : 0;
}

function ttlFromPlan(plan = {}, meta = {}) {
  const ttl = Number(plan.ttl ?? plan.expiresTicks ?? meta.ttl);
  return Number.isFinite(ttl) && ttl > 0 ? ttl : 80;
}

function expiresAtTick(plan = {}, currentTick = 0, meta = {}) {
  const explicit = Number(plan.expiresAtTick ?? plan.deadlineTick);
  if (Number.isFinite(explicit) && explicit >= currentTick) return explicit;
  return currentTick + ttlFromPlan(plan, meta);
}

function waitUntilTick(role = {}, plan = {}, currentTick = 0) {
  const explicit = Number(role.waitUntilTick ?? role.untilTick ?? plan.waitUntilTick ?? plan.untilTick);
  if (Number.isFinite(explicit)) return explicit;
  const ticks = Number(role.waitTicks ?? role.durationTicks ?? plan.waitTicks ?? plan.durationTicks);
  return currentTick + (Number.isFinite(ticks) && ticks > 0 ? ticks : 1);
}

function lightFrom(role = {}, plan = {}) {
  const raw = String(role.light ?? role.status ?? role.action ?? plan.initialLight ?? plan.light ?? "RED_LIGHT").trim().toUpperCase();
  if (raw === "GREEN" || raw === "GREEN_LIGHT" || raw === TEAM_MESSAGE_TYPES.GREEN_LIGHT) return TEAM_MESSAGE_TYPES.GREEN_LIGHT;
  return TEAM_MESSAGE_TYPES.RED_LIGHT;
}

function messageExpired(message, currentTick = 0) {
  const ttl = Number(message?.ttl ?? 0);
  if (ttl <= 0) return false;
  return Number(currentTick) > Number(message?.tick ?? 0) + ttl;
}

export class CoordinationController {
  constructor({ agentId, aliases = [], beliefs, missionRegistry = null, sendTeamMessage = null } = {}) {
    this.agentId = agentId;
    this.aliases = uniqueAliases([agentId, ...aliases]);
    this.beliefs = beliefs;
    this.missionRegistry = missionRegistry;
    this.sendTeamMessage = sendTeamMessage;
    this.plans = new Map();
    this.redLight = false;
    this.redLightReason = null;
    this.outbox = [];
  }

  setAliases(aliases = []) {
    this.aliases = uniqueAliases([this.agentId, ...aliases]);
    return this.aliases;
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

  resetForNewMap() {
    this.plans.clear();
    this.redLight = false;
    this.redLightReason = null;
    this.outbox = [];
  }

  movementBlocked(action = null) {
    if (!this.redLight) return false;
    if (!action || action.type !== "move") return false;
    return true;
  }

  receiveTeamMessage(message) {
    if (!message) return null;
    if (messageExpired(message, this.beliefs?.time ?? 0)) return { accepted: false, reason: "expired_team_message" };
    if (message.type === TEAM_MESSAGE_TYPES.POSITION_HEARTBEAT) {
      const teammate = this.beliefs?.updateTeamHeartbeat?.(message.payload, {
        receivedAtTick: this.beliefs?.time ?? message.tick,
        ttl: message.ttl,
        messageTick: message.tick
      });
      return { accepted: Boolean(teammate), type: message.type, teammate };
    }
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
      return this.receiveCoordinationPlan(message.payload?.coordinationPlan ?? message.payload, message.from, {
        ttl: message.ttl,
        tick: message.tick
      });
    }
    if (message.type === TEAM_MESSAGE_TYPES.SUBGOAL_ASSIGNMENT) {
      return this.receiveSubgoal(message.payload?.subgoal ?? message.payload, message.from);
    }
    if (message.type === TEAM_MESSAGE_TYPES.RENDEZVOUS_READY) {
      return this.receiveReady(message.payload ?? {}, message.from);
    }
    if (message.type === TEAM_MESSAGE_TYPES.STATUS_UPDATE && String(message.payload?.status ?? "").toUpperCase() === "READY") {
      return this.receiveReady(message.payload ?? {}, message.from);
    }
    if (message.type === TEAM_MESSAGE_TYPES.MISSION_COMPLETED) {
      const entry = this.findPlanForPayload(message.payload ?? {});
      if (!entry) return { accepted: false, reason: "unrelated_completion" };
      entry.state = COORDINATION_STATES.COMPLETED;
      this.missionRegistry?.markCompleted?.(entry.plan?.missionId ?? entry.id);
      return { accepted: true, state: entry.state };
    }
    if (message.type === TEAM_MESSAGE_TYPES.MISSION_FAILED) {
      const entry = this.findPlanForPayload(message.payload ?? {});
      if (!entry) return { accepted: false, reason: "unrelated_failure" };
      this.failPlan(entry, message.payload?.reason ?? "teammate_failed", message.from);
      return { accepted: true, state: entry.state };
    }
    if (message.type === TEAM_MESSAGE_TYPES.HANDOFF_REQUEST) {
      return this.failHandoff(message.payload, message.from);
    }
    return null;
  }

  teammatePosition(alias, currentTick = this.beliefs?.time ?? 0) {
    return this.beliefs?.teammatePosition?.(alias, currentTick) ?? null;
  }

  teamSummary(currentTick = this.beliefs?.time ?? 0) {
    return this.beliefs?.teammateSummary?.(currentTick) ?? { teammates: [], freshCount: 0, staleCount: 0 };
  }

  failPlan(entry, reason, to = entry?.from ?? null) {
    if (!entry) return null;
    if (entry.state === COORDINATION_STATES.FAILED || entry.state === COORDINATION_STATES.COMPLETED) return entry;
    entry.state = COORDINATION_STATES.FAILED;
    entry.reason = reason;
    this.missionRegistry?.markFailed?.(entry.plan?.missionId ?? entry.id, reason);
    this.emit(TEAM_MESSAGE_TYPES.MISSION_FAILED, {
      missionId: entry.plan?.missionId ?? entry.id,
      coordinationPlanId: entry.id,
      reason
    }, to);
    return entry;
  }

  completePlan(entry, to = entry?.from ?? null) {
    if (!entry) return null;
    if (entry.state === COORDINATION_STATES.COMPLETED) return entry;
    if (entry.state === COORDINATION_STATES.FAILED || entry.state === COORDINATION_STATES.ABORTED) return entry;
    entry.state = COORDINATION_STATES.COMPLETED;
    entry.reason = "coordination_completed";
    this.missionRegistry?.markCompleted?.(entry.plan?.missionId ?? entry.id);
    this.emit(TEAM_MESSAGE_TYPES.MISSION_COMPLETED, {
      missionId: entry.plan?.missionId ?? entry.id,
      coordinationPlanId: entry.id
    }, to);
    return entry;
  }

  findPlanForPayload(payload = {}) {
    const coordinationPlanId = payload.coordinationPlanId ?? payload.planId ?? payload.id ?? null;
    const missionId = payload.missionId ?? null;
    if (coordinationPlanId && this.plans.has(String(coordinationPlanId))) {
      return this.plans.get(String(coordinationPlanId));
    }
    if (!missionId) return null;
    for (const entry of this.plans.values()) {
      if (String(entry.plan?.missionId ?? entry.id) === String(missionId)) return entry;
    }
    return null;
  }

  receiveReady(payload = {}, from = null) {
    const entry = this.findPlanForPayload(payload);
    if (!entry) return { accepted: false, reason: "ready_not_correlated" };
    const now = this.beliefs?.time ?? 0;
    if (Number.isFinite(Number(entry.expiresAtTick)) && now > Number(entry.expiresAtTick)) {
      this.failPlan(entry, "coordination_plan_expired", from);
      return { accepted: false, reason: "coordination_plan_expired" };
    }
    if ([COORDINATION_STATES.FAILED, COORDINATION_STATES.COMPLETED, COORDINATION_STATES.ABORTED].includes(entry.state)) {
      return { accepted: false, reason: "plan_not_active" };
    }
    entry.teammateReady = true;
    entry.teammateReadyFrom = from;
    entry.teammateReadyTick = now;
    if (entry.localReady) {
      this.completePlan(entry, from);
      return { accepted: true, state: entry.state };
    }
    entry.state = COORDINATION_STATES.WAITING_TEAMMATE;
    return { accepted: true, state: entry.state };
  }

  markLocalReady(entry, reason = "ready") {
    if (!entry) return null;
    entry.localReady = true;
    entry.localReadyTick = this.beliefs?.time ?? 0;
    if (entry.readySent !== true) {
      if ([MISSION_TYPES.RENDEZVOUS, MISSION_TYPES.BOTH_NEAR_POSITION].includes(roleType(entry.role, entry.plan))) {
        this.emit(TEAM_MESSAGE_TYPES.RENDEZVOUS_READY, {
          missionId: entry.plan.missionId ?? entry.id,
          coordinationPlanId: entry.id,
          target: targetFrom(entry.role ?? entry.plan),
          position: this.beliefs?.me ? { x: this.beliefs.me.x, y: this.beliefs.me.y } : null
        }, entry.from);
      }
      this.emit(TEAM_MESSAGE_TYPES.STATUS_UPDATE, {
        status: "READY",
        missionId: entry.plan.missionId ?? entry.id,
        coordinationPlanId: entry.id,
        reason
      }, entry.from);
      entry.readySent = true;
    }
    if (entry.requiresTeammate && !entry.teammateReady) {
      entry.state = COORDINATION_STATES.WAITING_TEAMMATE;
      return entry;
    }
    this.completePlan(entry, entry.from);
    return entry;
  }

  validateRolePlan(plan, role) {
    const type = roleType(role, plan);
    if ([MISSION_TYPES.RENDEZVOUS, MISSION_TYPES.BOTH_NEAR_POSITION].includes(type)) {
      return targetFrom(role ?? plan)
        ? { ok: true, type }
        : { ok: false, reason: "missing_target" };
    }
    if (type === MISSION_TYPES.COORDINATED_WAIT) return { ok: true, type };
    if (type === MISSION_TYPES.RED_LIGHT_GREEN_LIGHT) return { ok: true, type };
    if (type === MISSION_TYPES.HANDOFF) return { ok: true, type };
    return { ok: false, reason: "unsupported_coordination_plan_type" };
  }

  receiveCoordinationPlan(plan, from = null, meta = {}) {
    if (!plan || typeof plan !== "object") return { accepted: false, reason: "invalid_coordination_plan" };
    const aliases = uniqueAliases([this.agentId, ...this.aliases]);
    const role = roleForAliases(plan, aliases);
    const id = planId(plan);
    if (!role) {
      this.emit(TEAM_MESSAGE_TYPES.STATUS_UPDATE, {
        status: "IGNORED",
        reason: "not_assigned",
        coordinationPlanId: id,
        missionId: plan.missionId ?? id
      }, from);
      return { accepted: false, reason: "not_assigned" };
    }

    const now = this.beliefs?.time ?? Number(meta.tick ?? 0) ?? 0;
    const validation = this.validateRolePlan(plan, role);
    const entry = {
      id,
      plan,
      from,
      state: COORDINATION_STATES.RECEIVED,
      role,
      createdAtTick: now,
      expiresAtTick: expiresAtTick(plan, now, meta),
      currentPhase: plan.phases?.[0]?.id ?? null,
      requiresTeammate: planRoleCount(plan) > 1,
      localReady: false,
      teammateReady: false,
      readySent: false
    };
    if (!validation.ok) {
      entry.state = COORDINATION_STATES.FAILED;
      entry.reason = validation.reason;
      this.plans.set(id, entry);
      this.emit(TEAM_MESSAGE_TYPES.MISSION_FAILED, {
        missionId: plan.missionId ?? id,
        coordinationPlanId: id,
        reason: validation.reason
      }, from);
      return { accepted: false, planId: id, state: entry.state, reason: validation.reason };
    }
    this.plans.set(id, entry);
    entry.state = COORDINATION_STATES.ACCEPTED;
    const applied = this.applyPlanRole(entry);
    if (applied.accepted === false) {
      this.failPlan(entry, applied.reason ?? "coordination_plan_apply_failed", from);
      return { accepted: false, planId: id, state: entry.state, reason: entry.reason };
    }
    this.emit(TEAM_MESSAGE_TYPES.MISSION_ACCEPTED, { missionId: plan.missionId ?? id, coordinationPlanId: id }, from);
    return { accepted: applied.accepted !== false, planId: id, state: entry.state, task: applied.task ?? null, reason: applied.reason };
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
    if (type === MISSION_TYPES.COORDINATED_WAIT || type === TEAM_MESSAGE_TYPES.WAIT_UNTIL) {
      const untilTick = waitUntilTick(subgoal, subgoal, this.beliefs?.time ?? 0);
      this.emit(TEAM_MESSAGE_TYPES.STATUS_UPDATE, {
        status: "WAITING_TEAMMATE",
        missionId: subgoal.missionId ?? null,
        untilTick,
        reason: subgoal.reason ?? "coordinated_wait"
      }, from);
      return { accepted: true, wait: true, untilTick };
    }
    if (type === MISSION_TYPES.RED_LIGHT_GREEN_LIGHT || type === TEAM_MESSAGE_TYPES.RED_LIGHT || type === TEAM_MESSAGE_TYPES.GREEN_LIGHT) {
      const light = lightFrom(subgoal, subgoal);
      this.redLight = light === TEAM_MESSAGE_TYPES.RED_LIGHT;
      this.redLightReason = this.redLight ? (subgoal.reason ?? "red_light_green_light") : null;
      this.emit(TEAM_MESSAGE_TYPES.STATUS_UPDATE, {
        status: this.redLight ? "RED_LIGHT_ACTIVE" : "GREEN_LIGHT_ACTIVE",
        missionId: subgoal.missionId ?? null,
        reason: this.redLightReason ?? subgoal.reason ?? "green_light"
      }, from);
      return { accepted: true, constraint: light, redLight: this.redLight };
    }
    if (type === MISSION_TYPES.HANDOFF) {
      return this.failHandoff(subgoal, from);
    }
    return { accepted: false, reason: "unsupported_subgoal" };
  }

  applyPlanRole(entry) {
    const plan = entry.plan;
    const type = roleType(entry.role, plan);
    if ([MISSION_TYPES.RENDEZVOUS, MISSION_TYPES.BOTH_NEAR_POSITION].includes(type)) {
      const target = targetFrom(entry.role ?? plan);
      if (target) {
        const result = this.receiveSubgoal({ ...entry.role, type, target, missionId: plan.missionId ?? entry.id }, entry.from);
        entry.state = COORDINATION_STATES.EXECUTING;
        return result;
      }
      return { accepted: false, reason: "missing_target" };
    }
    if (type === MISSION_TYPES.COORDINATED_WAIT) {
      const untilTick = waitUntilTick(entry.role, plan, this.beliefs?.time ?? 0);
      entry.waitUntilTick = untilTick;
      entry.state = COORDINATION_STATES.WAITING_TEAMMATE;
      return this.receiveSubgoal({ ...entry.role, type, missionId: plan.missionId ?? entry.id, untilTick }, entry.from);
    }
    if (type === MISSION_TYPES.RED_LIGHT_GREEN_LIGHT) {
      const result = this.receiveSubgoal({ ...entry.role, type, missionId: plan.missionId ?? entry.id }, entry.from);
      entry.state = result.redLight ? COORDINATION_STATES.WAITING_TEAMMATE : COORDINATION_STATES.EXECUTING;
      return result;
    }
    if (type === MISSION_TYPES.HANDOFF) {
      this.failHandoff(plan, entry.from);
      entry.state = COORDINATION_STATES.FAILED;
      entry.reason = "handoff_not_supported_by_environment";
      return { accepted: false, reason: entry.reason };
    }
    entry.state = COORDINATION_STATES.FAILED;
    entry.reason = "unsupported_coordination_plan_type";
    return { accepted: false, reason: entry.reason };
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
      if ([COORDINATION_STATES.FAILED, COORDINATION_STATES.COMPLETED, COORDINATION_STATES.ABORTED].includes(entry.state)) {
        continue;
      }
      const currentTick = this.beliefs?.time ?? 0;
      if (Number.isFinite(Number(entry.expiresAtTick)) && currentTick > Number(entry.expiresAtTick)) {
        this.failPlan(entry, "coordination_plan_expired");
        continue;
      }
      const team = this.teamSummary(currentTick);
      if (entry.requiresTeammate && team.teammates.length > 0 && team.freshCount === 0) {
        this.failPlan(entry, "teammate_stale");
        continue;
      }
      if (entry.state === COORDINATION_STATES.WAITING_TEAMMATE && Number.isFinite(Number(entry.waitUntilTick))) {
        if (currentTick >= Number(entry.waitUntilTick)) {
          this.markLocalReady(entry, "coordinated_wait_complete");
        }
        continue;
      }
      if (entry.state !== COORDINATION_STATES.EXECUTING) continue;
      const target = targetFrom(entry.role ?? entry.plan);
      const maxDistance = Number(entry.role?.maxDistance ?? entry.plan?.goal?.maxDistance ?? 0);
      if (target && distance(this.beliefs.me, target) <= maxDistance) {
        this.markLocalReady(entry, "coordination_target_reached");
      }
    }
    return readyMessages;
  }
}
