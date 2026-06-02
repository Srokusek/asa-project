import { Executor } from "../executor/executor.js";
import { buildExecutablePlan } from "../planner/executable-plan.js";
import {
  buildMapProfile,
  getDirectedNeighbors,
  isMoveAllowed,
  isWalkable,
  replan,
  shortestGridPath
} from "../planner/route-planner.js";
import { buildPlannerState } from "../state/planner-state.js";
import { tryImmediateAction } from "../strategy/reactive-layer.js";
import { trafficPolicyForBlockedMove } from "../strategy/traffic-policy.js";
import { createTelemetry } from "../telemetry/telemetry.js";
import { createLogger } from "../utils/logger.js";
import { directionFromPositions, manhattan, positionKey, sameTile } from "../utils/geometry.js";
import { createChatProcessor } from "./chat-processor.js";

const HARD_REPLAN_EVENTS = new Set([
  "MOVE_FAILED",
  "PATH_BLOCKED",
  "PACKAGE_STOLEN",
  "TARGET_NOT_FOUND",
  "BELIEF_INVALIDATED",
  "PICKUP_FAILED",
  "PUTDOWN_FAILED",
  "TEMPORARY_BLOCKED_CELL",
  "FORBIDDEN_TILE_ADDED",
  "PICKUP_MULTIPLIER_SET",
  "DELIVERY_MULTIPLIER_SET",
  "DELIVERY_COUNT_MULTIPLIER_SET"
]);

const PACKAGE_REPLAN_EVENTS = new Set([
  "NEW_PACKAGE_SPAWN"
]);

const IDLE_REPLAN_EVENTS = new Set([
  "MAP_READY"
]);

const TARGET_PLAN_MODES = new Set([
  "PICKUP_DELIVERY_UNIFIED"
]);
const INVALID_TARGET_PLAN_LIMIT = 3;
const SCOUT_PLAN_MODES = new Set([
  "SCOUT_UNIFIED",
  "LOCAL_EXPLORE"
]);

function eventType(event) {
  return typeof event === "string" ? event : event?.type;
}

export function normalizeActionDelayMs(config = {}) {
  const value = Number(config.actionDelayMs ?? 30);
  return Number.isFinite(value) ? Math.max(0, value) : 30;
}

function eventPayloadCount(event) {
  return Number(typeof event === "object" ? event.payload?.count ?? 0 : 0);
}

function hasEvent(events, eventSet) {
  return events.some((event) => eventSet.has(eventType(event)));
}

function hasVisibleParcelEvent(events) {
  return events.some((event) => eventType(event) === "PARCELS_SENSING" && eventPayloadCount(event) > 0);
  // if we have sensed a positive number of parcels, return true
}

function forbiddenTileEventPayload(event) {
  if (!event || typeof event !== "object") return null;
  const type = event.type;
  if (!type || !String(type).startsWith("FORBIDDEN_TILE_")) return null;
  const x = Number(event.payload?.x ?? event.payload?.target?.x);
  const y = Number(event.payload?.y ?? event.payload?.target?.y);
  return {
    type,
    x: Number.isFinite(x) ? x : null,
    y: Number.isFinite(y) ? y : null,
    reason: event.payload?.reason
  };
}

function multiplierEventPayload(event) {
  if (!event || typeof event !== "object") return null;
  const type = event.type;
  if (!type || !String(type).includes("MULTIPLIER_")) return null;
  const x = Number(event.payload?.x ?? event.payload?.target?.x);
  const y = Number(event.payload?.y ?? event.payload?.target?.y);
  const multiplier = Number(event.payload?.multiplier);
  const count = Number(event.payload?.count);
  return {
    type,
    x: Number.isFinite(x) ? x : null,
    y: Number.isFinite(y) ? y : null,
    count: Number.isFinite(count) ? count : null,
    multiplier: Number.isFinite(multiplier) ? multiplier : null,
    reason: event.payload?.reason
  };
}


export function routePathIsExecutable(routePlan) {
  /**
   * function for checking whether a path is executable
   * returns True in 2 cases:
   *  1) if the path is empty (since no contradictions are present)
   *  2) if all tiles are path are walkable and all moves between them are allowed (includes direction tiles restrictitons)
   */
  if (!routePlan?.state || !Array.isArray(routePlan.path)) return true; 
  if (!routePlan.path.every((position) => isWalkable(routePlan.state, position))) return false;
  for (let i = 0; i < routePlan.path.length - 1; i += 1) {
    if (!isMoveAllowed(routePlan.state, routePlan.path[i], routePlan.path[i + 1])) return false;
  }
  return true;
}

function isStartOnlyPlan(routePlan, executablePlan) {
  // checks whether current plan only contains start (no POIs)
  return (
    Array.isArray(routePlan?.sequence) &&
    routePlan.sequence.length === 1 &&
    routePlan.sequence[0] === "START" &&
    Array.isArray(executablePlan) &&
    executablePlan.length === 0
  );
}

function summarizeEvents(events = []) {
  // summarize events from event queue (such as failed movement, new package observation etc.)
  const counts = new Map();

  for (const event of events) {
    const type = eventType(event);
    if (!type) continue;
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }

  if (counts.size === 0) return "missing_or_periodic_plan";

  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([type, count]) => `${type}x${count}`)
    .join(",");
}

function summarizeScoutTarget(target) {
  // summarize the scouting target
  if (!target) return null;
  const rawId = String(target.id ?? "");
  const compactId = // compact id usefu for logging
    rawId.length > 80 ? `${rawId.slice(0, 60)}...` : rawId;
  return {
    id: compactId,
    score: target.score,
    primaryScore: target.primaryScore,
    position: target.position,
    distanceFromMe: target.distanceFromMe,
    distanceToNearestRed: target.distanceToNearestRed,
    trapPenaltyApplied: target.trapPenaltyApplied,
    pathCost: target.pathCost,
    checkpointValue: target.checkpointValue,
    stalenessComponent: target.stalenessComponent,
    multiplierComponent: target.multiplierComponent,
    repeatPenalty: target.repeatPenalty,
    coveredGreenCount: target.coveredGreenCount,
    sampleGreenIds: Array.isArray(target.sampleGreenIds) ? target.sampleGreenIds.slice(0, 5) : undefined
  };
}

export function compactSequence(sequence = []) {
  // move sequence for logging
  if (!Array.isArray(sequence)) return { text: "", sequenceLength: 0, truncated: false };
  if (sequence.length <= 8) {
    return { text: sequence.join(" -> "), sequenceLength: sequence.length, truncated: false };
  }
  return {
    text: `${sequence[0]} -> ${sequence[1]} -> ${sequence[2]} -> ... -> ${sequence.at(-1)}`,
    sequenceLength: sequence.length,
    truncated: true
  };
}

function compactCandidateDiagnostics(diagnostics = []) {
  if (!Array.isArray(diagnostics)) return [];
  const compact = diagnostics.slice(0, 10);
  if (diagnostics.length <= 10) return compact;
  return [...compact, { truncated: true, total: diagnostics.length }];
}

function compactScoutTargetId(id) {
  const rawId = String(id ?? "");
  if (rawId.length <= 80) return rawId;
  return `${rawId.slice(0, 60)}...`;
}

function copyPosition(position) {
  return { x: Math.round(Number(position.x)), y: Math.round(Number(position.y)) };
}

export class AgentLoop {
  constructor(socket, beliefs, config) {
    this.socket = socket;
    this.beliefs = beliefs;
    this.config = config;
    this.logger = createLogger(config.logLevel);
    this.telemetry = createTelemetry(config);
    this.executor = new Executor(socket, beliefs, config, this.telemetry); // handes all executions with Deliveroo.js
    this.currentRoutePlan = null;
    this.currentExecutablePlan = null;
    this.actionIndex = 0;
    this.lastPlanTime = -Infinity;
    this.timer = null;
    this.timerKind = null;
    this.ticking = false;
    this.started = false;
    this.lastFailedMoveKey = null;
    this.consecutiveMoveFailures = 0;
    this.lastBlockedMoveKey = null;
    this.sameBlockedMoveCount = 0;
    this.lastReplanCause = "missing_plan";
    this.invalidNonIdleZeroActionCount = 0;
    this.chatProcessor = createChatProcessor({ beliefs: this.beliefs, executor: this.executor, logger: this.logger });
    this.activeManualTask = null;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.logger.info("agent loop started");
    const interval = normalizeActionDelayMs(this.config);

    if (interval === 0) {
      const run = async () => {
        if (!this.started) return;
        await this.tick();
        if (!this.started) return;
        const idleDelay = this.beliefs.ready ? 0 : 20;
        this.timer = setTimeout(run, idleDelay);
      };
      this.timerKind = "timeout";
      this.timer = setTimeout(run, 0);
      return;
    }

    this.timerKind = "interval";
    this.timer = setInterval(() => {
      void this.tick();
    }, interval);
    void this.tick();
  }

  stop() {
    if (this.timerKind === "timeout") {
      clearTimeout(this.timer);
    } else if (this.timer) {
      clearInterval(this.timer);
    }
    this.timer = null;
    this.timerKind = null;
    this.started = false;
    this.logger.warn("agent loop stopped");
  }

  enemyRelevantToCurrentPlan(lookahead = 3) {
    // looks ahead in own path to check whether any enemy agents are on the path
    if (!this.currentExecutablePlan) return false;

    const dangerCells = new Set(
      this.currentExecutablePlan
        .slice(this.actionIndex)
        .filter((action) => action.type === "move")
        .slice(0, lookahead)
        .map((action) => `${action.to.x},${action.to.y}`)
    );

    for (const enemy of this.beliefs.agents.values()) {
      if (enemy.confidence < 0.4) continue; // ignore if we have low confidence (for example due to vision)
      if (dangerCells.has(`${enemy.x},${enemy.y}`)) return true;
    }

    return false;
  }

  explorationAction() {
    if (!this.beliefs.me) return null;

    const x = Math.round(Number(this.beliefs.me.x));
    const y = Math.round(Number(this.beliefs.me.y));
    const previousPosition = this.beliefs.lastPosition ?? this.beliefs.recentPositions?.at?.(-1) ?? null;
    const previousKey = previousPosition ? positionKey(previousPosition) : null;
    const plannerState = buildPlannerState(this.beliefs, this.config);
    const candidates = getDirectedNeighbors(plannerState, { x, y }).map((to) => ({
      direction: directionFromPositions({ x, y }, to),
      to
    }));
    const available = [];

    for (const candidate of candidates) {
      const reversePenalty = previousKey && positionKey(candidate.to) === previousKey ? 20 : 0;
      const rawStaleness = Number(this.beliefs.tileStaleness?.(candidate.to) ?? 0);
      const staleness = Number.isFinite(rawStaleness) ? rawStaleness : 100;
      available.push({
        type: "move",
        direction: candidate.direction,
        from: { x, y },
        to: candidate.to,
        reason: "agent-loop-fallback-exploration",
        score: staleness - reversePenalty
      });
    }

    if (available.length === 0) return null;
    available.sort((a, b) => b.score - a.score || a.direction.localeCompare(b.direction));
    const chosen = available[0];
    delete chosen.score;
    return chosen;
  }

  enemyOccupies(position) {
    for (const enemy of this.beliefs.agents.values()) {
      if (enemy.confidence < 0.5) continue;
      if (Math.round(enemy.x) === position.x && Math.round(enemy.y) === position.y) {
        return true;
      }
    }
    return false;
  }

  markScoutTargetVisitedIfInRange() {
    if (!SCOUT_PLAN_MODES.has(this.currentRoutePlan?.mode)) return;
    const scoutTarget = this.currentRoutePlan.scoutTarget;
    const target = scoutTarget?.position;
    if (!target || !this.beliefs.me) return;

    const sensingRange = Number(this.config.planner.sensingRange ?? 0);
    const currentPosition = copyPosition(this.beliefs.me);
    if (manhattan(currentPosition, target) > sensingRange) return;
    if (this.beliefs.greenRecentlyVisited?.(scoutTarget.id, this.config.planner.scoutCooldownTicks ?? 8)) return;

    this.beliefs.markScoutVisited(scoutTarget.id, target);
  }

  recordMoveFailure(action) {
    const key = `${action.from.x},${action.from.y}->${action.to.x},${action.to.y}`;

    if (key === this.lastFailedMoveKey) {
      this.consecutiveMoveFailures += 1;
    } else {
      this.lastFailedMoveKey = key;
      this.consecutiveMoveFailures = 1;
    }

    if (this.consecutiveMoveFailures >= 2) {
      this.beliefs.markTemporaryBlocked(action.to, 4, "repeated_move_failed");
    }

    this.recordBlockedMove(action, "move_failed");

    this.logger.warn("move failed", {
      blockedCell: action.to,
      consecutiveMoveFailures: this.consecutiveMoveFailures,
      sameBlockedMoveCount: this.sameBlockedMoveCount,
      temporaryBlockedCells: this.beliefs.temporaryBlockedCells?.size ?? 0
    });

    return this.consecutiveMoveFailures;
  }

  recordBlockedMove(action, reason) {
    if (!action?.from || !action?.to) return 0;
    const key = `${action.from.x},${action.from.y}->${action.to.x},${action.to.y}`;
    if (key === this.lastBlockedMoveKey) {
      this.sameBlockedMoveCount += 1;
    } else {
      this.lastBlockedMoveKey = key;
      this.sameBlockedMoveCount = 1;
    }

    if (this.config.planner.enableEdgeTemporaryBlocks !== false) {
      this.beliefs.markTemporaryBlockedEdge?.(
        action.from,
        action.to,
        this.config.planner.temporaryEdgeBlockTtlTicks ?? 2,
        reason
      );
    }

    return this.sameBlockedMoveCount;
  }

  summarizeVisiblePackages(routePlan) {
    const minConfidence = Number(this.config.planner.minParcelConfidence ?? 0.3);
    const candidatePackageIds = new Set(
      (routePlan?.candidateGreens ?? [])
        .map((green) => green.package?.id)
        .filter((id) => id !== undefined && id !== null)
        .map(String)
    );
    const ignoredVisiblePackages = [];
    let visiblePackagesCount = 0;

    for (const parcel of this.beliefs.parcels.values()) {
      if (parcel.carriedBy) continue;
      const reward = this.beliefs.estimateParcelReward?.(parcel) ?? Number(parcel.reward ?? 0);
      const confidence = Number(parcel.confidence ?? 0);
      const lastSeenTime = Number(parcel.lastSeenTime ?? -Infinity);
      const isVisible = confidence >= 1 || lastSeenTime >= Number(this.beliefs.time ?? 0);
      if (!isVisible || reward <= 0 || confidence < minConfidence) continue;

      visiblePackagesCount += 1;
      if (candidatePackageIds.has(String(parcel.id))) continue;
      if (ignoredVisiblePackages.length >= 10) continue;

      ignoredVisiblePackages.push({
        id: String(parcel.id),
        reward,
        confidence,
        distance: this.beliefs.me ? manhattan(this.beliefs.me, parcel) : null,
        reason: "not_candidate"
      });
    }

    return {
      visiblePackagesCount,
      candidatePackagesCount: candidatePackageIds.size,
      ignoredVisiblePackages
    };
  }

  resetMoveFailures() {
    this.lastFailedMoveKey = null;
    this.consecutiveMoveFailures = 0;
    this.lastBlockedMoveKey = null;
    this.sameBlockedMoveCount = 0;
  }

  hasValidParcelInBelief() {
    const minConfidence = Number(this.config.planner.minParcelConfidence ?? 0.3);
    for (const parcel of this.beliefs.parcels.values()) {
      if (parcel.carriedBy) continue;
      if (Number(parcel.confidence ?? 0) < minConfidence) continue;
      if (this.beliefs.estimateParcelReward(parcel) > 0) return true;
    }
    return false;
  }

  canUseFallbackExploration(routePlan = this.currentRoutePlan) {
    if (routePlan?.mode === "IDLE" || routePlan?.mode === "LOCAL_EXPLORE") return true;
    if (TARGET_PLAN_MODES.has(routePlan?.mode)) return false;
    const hasCandidates = (routePlan?.candidateGreens ?? []).length > 0;
    const hasCarried = this.beliefs.carriedParcels.size > 0;
    return !hasCandidates && !this.hasValidParcelInBelief() && !hasCarried;
  }

  isInvalidTargetZeroAction(routePlan = this.currentRoutePlan, executablePlan = this.currentExecutablePlan) {
    if (!TARGET_PLAN_MODES.has(routePlan?.mode)) return false;
    if (Array.isArray(executablePlan) && executablePlan.length > 0) return false;
    return true;
  }

  rejectInvalidZeroActionPlan(routePlan, reason = "invalid_non_idle_zero_action") {
    this.invalidNonIdleZeroActionCount += 1;
    const sequenceSummary = compactSequence(routePlan?.sequence);
    this.logger.warn("invalid non-idle zero-action plan", {
      mode: routePlan?.mode,
      sequence: sequenceSummary.text,
      sequenceLength: sequenceSummary.sequenceLength,
      sequenceTruncated: sequenceSummary.truncated,
      invalidNonIdleZeroActionCount: this.invalidNonIdleZeroActionCount,
      fallbackStage:
        this.invalidNonIdleZeroActionCount >= INVALID_TARGET_PLAN_LIMIT ? "scout" : routePlan?.fallbackStage
    });
    this.invalidatePlan(reason);
  }

  mustReplan(events = []) {
    const decide = (should, cause) => {
      this.lastReplanCause = cause;
      return should;
    };

    if (!this.currentRoutePlan || !this.currentExecutablePlan) return decide(true, "missing_plan");

    if (this.actionIndex >= this.currentExecutablePlan.length) {
      if (isStartOnlyPlan(this.currentRoutePlan, this.currentExecutablePlan)) {
        if (hasEvent(events, HARD_REPLAN_EVENTS)) return decide(true, "hard_event");
        if (hasEvent(events, PACKAGE_REPLAN_EVENTS)) return decide(true, "new_package");
        if (hasVisibleParcelEvent(events)) return decide(true, "parcel_visible");
        if (events.some((event) => IDLE_REPLAN_EVENTS.has(eventType(event)))) return decide(true, "missing_plan");
        const periodicIdle = Number(
          this.currentRoutePlan.config?.periodicReplanTicks ?? this.config.planner.periodicReplanTicks
        );
        if (periodicIdle > 0 && this.beliefs.time - this.lastPlanTime >= periodicIdle) {
          return decide(true, "idle_periodic");
        }
        return decide(false, "no_replan");
      }
      return decide(true, "plan_finished");
    }

    const hasAgentSensing = events.some((event) => eventType(event) === "AGENTS_SENSING");

    if (SCOUT_PLAN_MODES.has(this.currentRoutePlan?.mode)) {
      if (!routePathIsExecutable(this.currentRoutePlan)) return decide(true, "scout_path_not_executable");
      if (hasEvent(events, HARD_REPLAN_EVENTS)) return decide(true, "hard_event");
      if (hasEvent(events, PACKAGE_REPLAN_EVENTS)) return decide(true, "new_package");
      if (hasVisibleParcelEvent(events)) return decide(true, "parcel_visible");
      if (hasAgentSensing && this.enemyRelevantToCurrentPlan()) return decide(true, "enemy_relevant");
      return decide(false, "scout_commitment_keep_plan");
    }

    if (hasAgentSensing && this.enemyRelevantToCurrentPlan()) return decide(true, "enemy_relevant");
    if (hasEvent(events, HARD_REPLAN_EVENTS)) return decide(true, "hard_event");
    if (hasEvent(events, PACKAGE_REPLAN_EVENTS)) return decide(true, "new_package");

    const periodic = Number(this.currentRoutePlan.config?.periodicReplanTicks ?? this.config.planner.periodicReplanTicks);
    if (periodic > 0 && this.beliefs.time - this.lastPlanTime >= periodic) return decide(true, "periodic");

    return decide(false, "no_replan");
  }

  buildManualGotoPlan(task, plannerState) {
    if (!plannerState?.me?.position) return null;
    const target = task?.payload?.target;
    if (!target) return null;

    const start = { x: Math.round(Number(plannerState.me.position.x)), y: Math.round(Number(plannerState.me.position.y)) };
    const goal = { x: Math.round(Number(target.x)), y: Math.round(Number(target.y)) };
    if (!Number.isFinite(goal.x) || !Number.isFinite(goal.y)) return null;
    if (this.beliefs.isForbiddenTile?.(goal)) return null;
    if (sameTile(start, goal)) {
      return {
        mode: "MANUAL_GOTO",
        sequence: ["START"],
        path: [start],
        value: 0,
        state: plannerState,
        config: this.config.planner,
        manualTaskId: task.id,
        manualTarget: goal
      };
    }

    const profile = buildMapProfile(plannerState);
    const shortest = shortestGridPath(plannerState, start, goal, profile);
    if (!Array.isArray(shortest?.path) || shortest.path.length === 0 || !Number.isFinite(shortest.cost)) return null;
    return {
      mode: "MANUAL_GOTO",
      sequence: ["START", `MANUAL_TARGET_${goal.x}_${goal.y}`],
      path: shortest.path,
      value: -shortest.cost,
      state: plannerState,
      profile,
      config: this.config.planner,
      manualTaskId: task.id,
      manualTarget: goal
    };
  }

  ensureManualPlan() {
    if (this.activeManualTask && Number(this.activeManualTask.expiresAtTick ?? -1) <= this.beliefs.time) {
      this.telemetry.record("manual_task_failed", {
        taskId: this.activeManualTask.id,
        reason: "expired",
        target: this.activeManualTask?.payload?.target ?? null
      });
      this.logger.warn("manual task failed", {
        taskId: this.activeManualTask.id,
        reason: "expired",
        target: this.activeManualTask?.payload?.target ?? null
      });
      this.activeManualTask = null;
      this.invalidatePlan("manual_task_expired");
    }

    const task = this.activeManualTask ?? this.beliefs.peekManualTask?.();
    if (!task) return false;
    this.activeManualTask = task;

    if (
      this.currentRoutePlan?.mode === "MANUAL_GOTO" &&
      Number(this.currentRoutePlan?.manualTaskId) === Number(task.id) &&
      Array.isArray(this.currentExecutablePlan)
    ) {
      return true;
    }

    const plannerState = buildPlannerState(this.beliefs, this.config);
    const routePlan = this.buildManualGotoPlan(task, plannerState);
    if (!routePlan) {
      this.telemetry.record("manual_task_retry", {
        taskId: task.id,
        reason: "path_not_found",
        target: task?.payload?.target ?? null
      });
      this.logger.warn("manual task retry", {
        taskId: task.id,
        reason: "path_not_found",
        target: task?.payload?.target ?? null
      });
      this.invalidatePlan("manual_task_retry_path_not_found");
      return true;
    }

    this.currentRoutePlan = routePlan;
    this.currentExecutablePlan = buildExecutablePlan(routePlan);
    this.actionIndex = 0;
    this.lastPlanTime = this.beliefs.time;
    this.lastReplanCause = "manual_task";
    this.telemetry.record("manual_task_started", {
      taskId: task.id,
      mode: routePlan.mode,
      target: routePlan.manualTarget,
      actionCount: this.currentExecutablePlan.length
    });
    this.logger.info("manual task started", {
      taskId: task.id,
      target: routePlan.manualTarget,
      actionCount: this.currentExecutablePlan.length
    });
    return true;
  }

  makePlan(events = []) {
    const start = Date.now();
    // collect the planner state
    const plannerState = buildPlannerState(this.beliefs, this.config);
    const plannerSummary = {
      width: plannerState.width,
      height: plannerState.height,
      greens: plannerState.greens.length,
      greensWithPackage: plannerState.greens.filter((green) => green.package).length,
      reds: plannerState.reds.length,
      parcelsInBelief: this.beliefs.parcels.size,
      carried: this.beliefs.carriedParcels.size,
      temporaryBlockedCells: this.beliefs.temporaryBlockedCells?.size ?? 0,
      pickupMultiplierRules: this.beliefs.pickupTileMultipliers?.size ?? 0,
      deliveryMultiplierRules: this.beliefs.deliveryTileMultipliers?.size ?? 0,
      me: this.beliefs.me
    };
    const routePlan = replan(plannerState);
    let executablePlan = routePathIsExecutable(routePlan) ? buildExecutablePlan(routePlan) : [];
    const elapsed = Date.now() - start;
    this.logger.debug("planner state summary", { ...plannerSummary, mode: routePlan.mode });

    if (routePlan.mode !== "IDLE" && executablePlan.length === 0) {
      const sequenceSummary = compactSequence(routePlan.sequence);
      this.logger.warn("non-idle plan produced zero actions", {
        mode: routePlan.mode,
        sequence: sequenceSummary.text,
        sequenceLength: sequenceSummary.sequenceLength,
        sequenceTruncated: sequenceSummary.truncated
      });

      if (!this.canUseFallbackExploration(routePlan)) {
        this.currentRoutePlan = routePlan;
        this.currentExecutablePlan = executablePlan;
        this.actionIndex = 0;
        this.rejectInvalidZeroActionPlan(routePlan);
        return;
      }

      const fallbackAction = this.explorationAction();
      if (fallbackAction) {
        executablePlan = [fallbackAction];
      } else {
        this.currentRoutePlan = routePlan;
        this.currentExecutablePlan = executablePlan;
        this.actionIndex = 0;
        this.invalidatePlan("non_idle_zero_actions");
        return;
      }
    }

    if (executablePlan.length === 0 && routePlan.sequence.length > 1) {
      const sequenceSummary = compactSequence(routePlan.sequence);
      this.logger.warn("planner produced a non-executable path", {
        sequence: sequenceSummary.text,
        sequenceLength: sequenceSummary.sequenceLength,
        sequenceTruncated: sequenceSummary.truncated
      });
    }

    this.currentRoutePlan = routePlan;
    this.currentExecutablePlan = executablePlan;
    this.actionIndex = 0;
    this.lastPlanTime = this.beliefs.time;
    if (executablePlan.length > 0) this.invalidNonIdleZeroActionCount = 0;
    this.beliefs.clearDirty();
    if (SCOUT_PLAN_MODES.has(routePlan.mode) && routePlan.scoutTarget?.id) {
      this.beliefs.markScoutTargetAttempt?.(routePlan.scoutTarget.id, this.beliefs.time);
    }

    const eventsSeen = summarizeEvents(events);
    const replanCause = this.lastReplanCause ?? "missing_plan";
    const candidates = (routePlan.candidateGreens ?? []).map((green) => green.id).join(",");
    const scoutTarget = summarizeScoutTarget(routePlan.scoutTarget);
    const sequenceSummary = compactSequence(routePlan.sequence);
    const candidateDiagnostics = compactCandidateDiagnostics(routePlan.candidateDiagnostics);
    const visiblePackageSummary = this.summarizeVisiblePackages(routePlan);
    const adjustedValues = (routePlan.candidateDiagnostics ?? [])
      .map((entry) => Number(entry?.estimatedDeliveredValue))
      .filter((value) => Number.isFinite(value));
    const adjustedDeliveredEstimateMax =
      adjustedValues.length > 0 ? Math.max(...adjustedValues) : null;
    this.logger.info("replan", {
      eventsSeen,
      replanCause,
      mode: routePlan.mode,
      sequence: sequenceSummary.text,
      sequenceLength: sequenceSummary.sequenceLength,
      sequenceTruncated: sequenceSummary.truncated,
      value: routePlan.value,
      actions: executablePlan.length,
      candidates,
      invalidPlanDetected: Boolean(routePlan.invalidPlanDetected),
      fallbackStage: routePlan.fallbackStage ?? "full_plan",
      hasDirectionalTiles: Boolean(routePlan.hasDirectionalTiles ?? routePlan.profile?.hasDirectionalTiles),
      directedDistanceFieldsBuilt: Boolean(routePlan.directedDistanceFieldsBuilt),
      candidateDiagnostics,
      ...visiblePackageSummary,
      activePickupMultiplierRules: this.beliefs.pickupTileMultipliers?.size ?? 0,
      activeDeliveryMultiplierRules: this.beliefs.deliveryTileMultipliers?.size ?? 0,
      adjustedDeliveredEstimateMax,
      scoutTarget,
      oraclePoints: routePlan.oracle?.points?.length ?? 0,
      oraclePathfindingCalls: routePlan.oracle?.stats?.pathfindingCalls ?? 0,
      oracleSingleSourceBfsRuns: routePlan.oracle?.stats?.singleSourceBfsRuns ?? 0,
      oracleEdgeRequests: routePlan.oracle?.stats?.edgeRequests ?? 0,
      oracleLazyEdgeComputes: routePlan.oracle?.stats?.lazyEdgeComputes ?? 0,
      oracleCostCacheHits: routePlan.oracle?.stats?.costCacheHits ?? 0,
      oraclePathComputes: routePlan.oracle?.stats?.pathComputes ?? 0,
      staticIndexBuildMs: routePlan.oracle?.stats?.staticIndexBuildMs ?? 0,
      staticIndexReuseCount: routePlan.oracle?.stats?.staticIndexReuseCount ?? 0,
      startSingleSourceMs: routePlan.oracle?.stats?.startSingleSourceMs ?? 0,
      dynamicPathRepairs: routePlan.oracle?.stats?.dynamicPathRepairs ?? 0,
      dynamicRepairFailReplans: routePlan.oracle?.stats?.dynamicRepairFailReplans ?? 0,
      greenRecentlyVisited: routePlan.scoutTarget
        ? this.beliefs.greenRecentlyVisited?.(
            routePlan.scoutTarget.id,
            this.config.planner.scoutCooldownTicks ?? 8
          )
        : undefined,
      temporaryBlockedCells: this.beliefs.temporaryBlockedCells?.size ?? 0,
      elapsedMs: elapsed
    });

    this.telemetry.record("replan", {
      mode: routePlan.mode,
      currentPosition: plannerState.me?.position,
      target: routePlan.scoutTarget?.position ?? routePlan.path?.at?.(-1) ?? null,
      sequence: sequenceSummary.text,
      sequenceLength: sequenceSummary.sequenceLength,
      sequenceTruncated: sequenceSummary.truncated,
      expectedValue: routePlan.value,
      score: this.beliefs.me?.score,
      parcelsInBelief: this.beliefs.parcels.size,
      greensWithPackage: plannerSummary.greensWithPackage,
      carriedCount: this.beliefs.carriedParcels.size,
      planningTimeMs: elapsed,
      temporaryBlockedCells: this.beliefs.temporaryBlockedCells?.size ?? 0,
      scoutTarget: compactScoutTargetId(routePlan.scoutTarget?.id),
      scoutTargetDetails: scoutTarget,
      candidateCount: routePlan.candidateGreens?.length ?? 0,
      invalidPlanDetected: Boolean(routePlan.invalidPlanDetected),
      fallbackStage: routePlan.fallbackStage ?? "full_plan",
      hasDirectionalTiles: Boolean(routePlan.hasDirectionalTiles ?? routePlan.profile?.hasDirectionalTiles),
      directedDistanceFieldsBuilt: Boolean(routePlan.directedDistanceFieldsBuilt),
      candidateDiagnostics,
      ...visiblePackageSummary,
      activePickupMultiplierRules: this.beliefs.pickupTileMultipliers?.size ?? 0,
      activeDeliveryMultiplierRules: this.beliefs.deliveryTileMultipliers?.size ?? 0,
      adjustedDeliveredEstimateMax,
      oraclePoints: routePlan.oracle?.points?.length ?? 0,
      oraclePathfindingCalls: routePlan.oracle?.stats?.pathfindingCalls ?? 0,
      oracleSingleSourceBfsRuns: routePlan.oracle?.stats?.singleSourceBfsRuns ?? 0,
      oracleEdgeRequests: routePlan.oracle?.stats?.edgeRequests ?? 0,
      oracleLazyEdgeComputes: routePlan.oracle?.stats?.lazyEdgeComputes ?? 0,
      oracleCostCacheHits: routePlan.oracle?.stats?.costCacheHits ?? 0,
      oraclePathComputes: routePlan.oracle?.stats?.pathComputes ?? 0,
      staticIndexBuildMs: routePlan.oracle?.stats?.staticIndexBuildMs ?? 0,
      staticIndexReuseCount: routePlan.oracle?.stats?.staticIndexReuseCount ?? 0,
      startSingleSourceMs: routePlan.oracle?.stats?.startSingleSourceMs ?? 0,
      dynamicPathRepairs: routePlan.oracle?.stats?.dynamicPathRepairs ?? 0,
      dynamicRepairFailReplans: routePlan.oracle?.stats?.dynamicRepairFailReplans ?? 0,
      actionCount: executablePlan.length,
      eventsSeen,
      replanCause,
      reason: replanCause
    });

    if (elapsed > this.config.planner.planningBudgetMs) {
      this.logger.warn("planning exceeded budget", { elapsedMs: elapsed, budgetMs: this.config.planner.planningBudgetMs });
    }
  }

  invalidatePlan(reason) {
    this.logger.warn("invalidate plan", reason);
    this.currentRoutePlan = null;
    this.currentExecutablePlan = null;
    this.actionIndex = 0;
  }

  async executeImmediateAction(action, reason = "reactive_immediate_action") {
    this.logger.debug("execute immediate action", { action, reason });
    this.telemetry.record("action_start", {
      mode: this.currentRoutePlan?.mode ?? "PICKUP_DELIVERY_UNIFIED",
      currentPosition: this.beliefs.me ? { x: this.beliefs.me.x, y: this.beliefs.me.y } : null,
      target: action?.at ?? action?.to ?? null,
      sequence: reason,
      action,
      score: this.beliefs.me?.score,
      parcelsInBelief: this.beliefs.parcels.size,
      carriedCount: this.beliefs.carriedParcels.size,
      temporaryBlockedCells: this.beliefs.temporaryBlockedCells?.size ?? 0
    });
    const ok = await this.executor.execute(action);
    if (ok === false) {
      this.telemetry.record("action_failed", {
        mode: this.currentRoutePlan?.mode ?? "PICKUP_DELIVERY_UNIFIED",
        action,
        result: false,
        reason
      });
      this.invalidatePlan(`${reason}_failed`);
      return false;
    }
    this.telemetry.record("action_completed", {
      mode: this.currentRoutePlan?.mode ?? "PICKUP_DELIVERY_UNIFIED",
      action,
      result: ok,
      reason
    });
    this.invalidatePlan(reason);
    return true;
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true; // mark that a tick is in progress

    try {
      this.telemetry.nextTick();
      if (typeof this.beliefs.advanceTimeFromClock === "function") {
        this.beliefs.advanceTimeFromClock();
      } else {
        this.beliefs.advanceTime();
      }
      const events = this.beliefs.consumeEvents();
      for (const event of events) {
        const payload = forbiddenTileEventPayload(event);
        if (payload) {
          if (payload.type === "FORBIDDEN_TILE_ADDED") {
            this.telemetry.record("forbidden_tile_added", payload);
          } else if (payload.type === "FORBIDDEN_TILE_REJECTED") {
            this.telemetry.record("forbidden_tile_rejected", payload);
          }
        }
        const multiplierPayload = multiplierEventPayload(event);
        if (multiplierPayload) {
          if (multiplierPayload.type === "PICKUP_MULTIPLIER_SET") {
            this.telemetry.record("pickup_multiplier_set", multiplierPayload);
          } else if (multiplierPayload.type === "DELIVERY_MULTIPLIER_SET") {
            this.telemetry.record("delivery_multiplier_set", multiplierPayload);
          } else if (multiplierPayload.type === "DELIVERY_COUNT_MULTIPLIER_SET") {
            this.telemetry.record("delivery_count_multiplier_set", multiplierPayload);
          }
        }
      }
      // events is a list of all events that the agent has sensed since the last tick
      if (!this.beliefs.ready) return; // stop if connection, map or other crucial steps have not been resolved yet

      this.chatProcessor.kick?.();

      const reactive = tryImmediateAction({
        beliefs: this.beliefs,
        currentRoutePlan: this.currentRoutePlan,
        currentExecutablePlan: this.currentExecutablePlan,
        actionIndex: this.actionIndex,
        config: this.config
      });
      let keepCurrentPlanForReactiveAction = false;
      if (reactive?.routePlan && reactive?.executablePlan) {
        this.currentRoutePlan = reactive.routePlan;
        this.currentExecutablePlan = reactive.executablePlan;
        this.actionIndex = 0;
        this.lastPlanTime = this.beliefs.time;
        this.lastReplanCause = "reactive_immediate_pickup";
      } else if (reactive?.action && reactive.immediate) {
        await this.executeImmediateAction(reactive.action, reactive.action.reason ?? "reactive_immediate_action");
        return;
      } else if (reactive?.fromCurrentPlan) {
        keepCurrentPlanForReactiveAction = true;
      }

      if (this.ensureManualPlan()) {
        // manual plan has priority over automatic replanning
      } else if (!keepCurrentPlanForReactiveAction && this.mustReplan(events)) {
        // check whether sensed events constitute to having to replan
        this.makePlan(events);
      }

      // stop if we have no executable route plan
      if (!this.currentRoutePlan || !this.currentExecutablePlan) return;

      // get the next action in plan
      const action = this.currentExecutablePlan?.[this.actionIndex];
      if (!action) {
        // if there is no executable action, check for possible reasons
        if (this.isInvalidTargetZeroAction(this.currentRoutePlan, this.currentExecutablePlan)) {
          this.rejectInvalidZeroActionPlan(this.currentRoutePlan);
          return;
        }
        if (isStartOnlyPlan(this.currentRoutePlan, this.currentExecutablePlan)) {
          return;
        }
        if (this.canUseFallbackExploration(this.currentRoutePlan)) {
          // get a fallback plan if possible
          const fallbackAction = this.explorationAction();
          if (fallbackAction) {
            this.currentExecutablePlan = [fallbackAction];
            this.actionIndex = 0;
          } else {
            this.invalidatePlan("plan_finished_or_empty");
          }
          return;
        }
        this.invalidatePlan("plan_finished_or_empty");
        return;
      }

      this.logger.debug("execute action", {
        index: this.actionIndex,
        action,
        sequence: compactSequence(this.currentRoutePlan?.sequence).text
      });

      // take note if there is another agent in the target tile of a move action
      if (action.type === "move" && action.to && this.enemyOccupies(action.to)) {
        const blockedMode = this.currentRoutePlan?.mode;
        // keep track of repeated cases of this happening
        const repeated = this.recordBlockedMove(action, "enemy_in_next_cell");
        // mark the tile as temporarily blocked for 2 ticks
        this.beliefs.markTemporaryBlocked(action.to, 2, "enemy_in_next_cell");
        this.logger.warn("enemy_in_next_cell", {
          blockedCell: action.to,
          repeatedBlockedMove: repeated,
          temporaryBlockedCells: this.beliefs.temporaryBlockedCells?.size ?? 0
        });
        this.telemetry.record("enemy_in_next_cell", {
          mode: blockedMode,
          currentPosition: this.beliefs.me ? { x: this.beliefs.me.x, y: this.beliefs.me.y } : null,
          action,
          result: false,
          temporaryBlockedCells: this.beliefs.temporaryBlockedCells?.size ?? 0
        });
        const traffic = trafficPolicyForBlockedMove({
          beliefs: this.beliefs,
          action,
          repeatedCount: repeated,
          config: this.config,
          sidestepAction: this.explorationAction()
        });
        if (traffic.type === "wait") {
          this.telemetry.record("traffic_wait", { action, reason: traffic.reason, repeated });
          return;
        }
        if (traffic.type === "sidestep" && traffic.action) {
          this.telemetry.record("traffic_sidestep", { action: traffic.action, reason: traffic.reason, repeated });
          await this.executeImmediateAction(traffic.action, traffic.reason);
          return;
        }
        if (repeated >= Number(this.config.planner.maxRepeatedBlockedMovesBeforeReplan ?? 2)) {
          this.logger.warn("repeatedBlockedMove", {
            action,
            sameBlockedMoveCount: repeated,
            reason: "enemy_in_next_cell"
          });
        }
        this.invalidatePlan("enemy_in_next_cell");
        return;
      }

      // if we have an executable action, record the start of the action with related beliefs
      this.telemetry.record("action_start", {
        mode: this.currentRoutePlan?.mode,
        currentPosition: this.beliefs.me ? { x: this.beliefs.me.x, y: this.beliefs.me.y } : null,
        target: this.currentRoutePlan?.path?.at?.(-1) ?? null,
        sequence: compactSequence(this.currentRoutePlan?.sequence).text,
        action,
        score: this.beliefs.me?.score,
        expectedValue: this.currentRoutePlan?.value,
        parcelsInBelief: this.beliefs.parcels.size,
        greensWithPackage: this.currentRoutePlan?.state?.greens?.filter((green) => green.package).length ?? 0,
        carriedCount: this.beliefs.carriedParcels.size,
        temporaryBlockedCells: this.beliefs.temporaryBlockedCells?.size ?? 0,
        scoutTarget: this.currentRoutePlan?.scoutTarget?.id,
        candidateCount: this.currentRoutePlan?.candidateGreens?.length ?? 0
      });

      // await response from deliveroo
      const ok = await this.executor.execute(action);

      // if action failed:
      if (ok === false) {
        if (action.type === "move") {
          // if the action was a move, count how many times it has failed (specific to lcoation)
          // note: the count gets reset after a success
          const failures = this.recordMoveFailure(action);
          const repeatedLimit = Number(this.config.planner.maxRepeatedBlockedMovesBeforeReplan ?? 2);
          // log warning about failure
          if (this.sameBlockedMoveCount >= repeatedLimit) {
            this.logger.warn("repeatedBlockedMove", {
              action,
              sameBlockedMoveCount: this.sameBlockedMoveCount,
              reason: "move_failed"
            });
            this.telemetry.record("repeated_blocked_move", {
              mode: this.currentRoutePlan?.mode,
              action,
              sameBlockedMoveCount: this.sameBlockedMoveCount
            });
          } else if (failures >= 3) {
            // if we have 3 or more move failures here, force a "sidestep" action
            const sidestep = this.explorationAction();
            if (sidestep) {
              this.logger.warn("forced sidestep after repeated move failure", {
                action: sidestep,
                consecutiveMoveFailures: failures
              });
              await this.executor.execute(sidestep);
            }
          }
        }
        this.telemetry.record("action_failed", {
          mode: this.currentRoutePlan?.mode,
          action,
          result: false,
          consecutiveMoveFailures: this.consecutiveMoveFailures,
          temporaryBlockedCells: this.beliefs.temporaryBlockedCells?.size ?? 0
        });
        if (this.currentRoutePlan?.mode === "MANUAL_GOTO" && this.activeManualTask) {
          this.telemetry.record("manual_task_retry", {
            taskId: this.activeManualTask.id,
            reason: "action_failed",
            target: this.currentRoutePlan?.manualTarget ?? this.activeManualTask?.payload?.target ?? null
          });
          this.logger.warn("manual task retry", {
            taskId: this.activeManualTask.id,
            reason: "action_failed_replan",
            target: this.currentRoutePlan?.manualTarget ?? this.activeManualTask?.payload?.target ?? null
          });
        }
        this.invalidatePlan("action_failed");
        return;
      }

      // if move action was successful, reset failure counts
      if (action.type === "move") {
        this.resetMoveFailures();
        // take note of observed tiles within vision
        this.markScoutTargetVisitedIfInRange();
      }

      // increment the action index
      this.actionIndex += 1;
      if (this.actionIndex >= this.currentExecutablePlan.length) {
        const completedManualTask = this.currentRoutePlan?.mode === "MANUAL_GOTO" ? this.activeManualTask : null;
        // if this has finished the plan:
        if (SCOUT_PLAN_MODES.has(this.currentRoutePlan?.mode) && this.currentRoutePlan.scoutTarget) {
          // if the plan was a scouting plan, mark target location as scouted
          this.beliefs.markScoutVisited(
            this.currentRoutePlan.scoutTarget.id,
            this.currentRoutePlan.scoutTarget.position
          );
        }
        this.telemetry.record("plan_completed", {
          // for other plan types, mark as completed
          mode: this.currentRoutePlan?.mode,
          sequence: compactSequence(this.currentRoutePlan?.sequence).text,
          scoutTarget: compactScoutTargetId(this.currentRoutePlan?.scoutTarget?.id),
          currentPosition: this.beliefs.me ? { x: this.beliefs.me.x, y: this.beliefs.me.y } : null
        });
        if (completedManualTask) {
          this.telemetry.record("manual_task_completed", {
            taskId: completedManualTask.id,
            target: this.currentRoutePlan?.manualTarget ?? completedManualTask?.payload?.target ?? null
          });
          this.logger.info("manual task completed", {
            taskId: completedManualTask.id,
            target: this.currentRoutePlan?.manualTarget ?? completedManualTask?.payload?.target ?? null
          });
          this.beliefs.consumeManualTask?.();
          this.activeManualTask = null;
        }
        this.invalidatePlan("plan_completed");
      }
    } catch (error) {
      this.logger.error("loop tick failed", error);
      this.invalidatePlan("tick_exception");
    } finally {
      this.ticking = false;
    }
  }
}
