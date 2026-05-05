import { Executor } from "../executor/executor.js";
import { buildExecutablePlan } from "../planner/executable-plan.js";
import {
  buildMapProfile,
  directionFromPositions,
  fallbackFastPlan,
  getDirectedNeighbors,
  isMoveAllowed,
  isWalkable,
  replan,
  shortestGridPath
} from "../planner/route-planner.js";
import { buildPlannerState } from "../state/planner-state.js";
import { createTelemetry } from "../telemetry/telemetry.js";
import { createLogger } from "../utils/logger.js";

const HARD_REPLAN_EVENTS = new Set([
  "MOVE_FAILED",
  "PATH_BLOCKED",
  "PACKAGE_STOLEN",
  "TARGET_NOT_FOUND",
  "BELIEF_INVALIDATED",
  "PICKUP_FAILED",
  "PUTDOWN_FAILED",
  "TEMPORARY_BLOCKED_CELL",
  "TEMPORARY_BLOCKED_EDGE"
]);

const PACKAGE_REPLAN_EVENTS = new Set([
  "NEW_PACKAGE_SPAWN"
]);

const IDLE_REPLAN_EVENTS = new Set([
  "MAP_READY"
]);

const TARGET_PLAN_MODES = new Set(["PICKUP_DELIVERY", "DELIVERY_ONLY", "PICKUP_ONLY", "OPPORTUNISTIC_PICKUP"]);
const INVALID_TARGET_PLAN_LIMIT = 3;
const SCOUT_PLAN_MODES = new Set([
  "SCOUT",
  "DENSE_SCOUT",
  "GREEN_EXPOSURE_SCOUT",
  "LOW_VISIBILITY_COVERAGE_SCOUT",
  "LOCAL_EXPLORE",
  "LOCAL_EXPLORE_FAST"
]);

function eventType(event) {
  return typeof event === "string" ? event : event?.type;
}

function eventCount(event) {
  return Math.max(1, Math.round(Number(typeof event === "object" ? event.count ?? 1 : 1)));
}

function eventPayloadCount(event) {
  return Number(typeof event === "object" ? event.payload?.count ?? 0 : 0);
}

function hasEvent(events, eventSet) {
  return events.some((event) => eventSet.has(eventType(event)));
}

function hasVisibleParcelEvent(events) {
  return events.some((event) => eventType(event) === "PARCELS_SENSING" && eventPayloadCount(event) > 0);
}

export function routePathIsExecutable(routePlan) {
  if (!routePlan?.state || !Array.isArray(routePlan.path)) return true;
  if (!routePlan.path.every((position) => isWalkable(routePlan.state, position))) return false;
  for (let i = 0; i < routePlan.path.length - 1; i += 1) {
    if (!isMoveAllowed(routePlan.state, routePlan.path[i], routePlan.path[i + 1])) return false;
  }
  return true;
}

function isStartOnlyPlan(routePlan, executablePlan) {
  return (
    Array.isArray(routePlan?.sequence) &&
    routePlan.sequence.length === 1 &&
    routePlan.sequence[0] === "START" &&
    Array.isArray(executablePlan) &&
    executablePlan.length === 0
  );
}

function summarizeEvents(events = []) {
  const counts = new Map();

  for (const event of events) {
    const type = eventType(event);
    if (!type) continue;
    counts.set(type, (counts.get(type) ?? 0) + eventCount(event));
  }

  if (counts.size === 0) return "missing_or_periodic_plan";

  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([type, count]) => `${type}x${count}`)
    .join(",");
}

function summarizeScoutTarget(target) {
  if (!target) return null;
  const rawId = String(target.id ?? "");
  const compactId =
    rawId.length > 80 && target.size
      ? `CLUSTER_size_${target.size}_centroid_${target.centroid?.x ?? "?"}_${target.centroid?.y ?? "?"}`
      : rawId.length > 80
        ? `${rawId.slice(0, 60)}...`
        : rawId;
  return {
    id: compactId,
    size: target.size,
    centroid: target.centroid,
    staleness: target.staleness,
    infoValue: target.infoValue,
    scoutScore: target.scoutScore ?? target.score,
    score: target.score,
    position: target.position,
    distanceFromMe: target.distanceFromMe,
    distanceToNearestRed: target.distanceToNearestRed ?? target.redDistance,
    trapPenaltyApplied: target.trapPenaltyApplied,
    sampleGreenIds: Array.isArray(target.greenIds) ? target.greenIds.slice(0, 5) : undefined,
    clusterBonus: target.clusterBonus,
    debtBonus: target.debtBonus,
    redPenalty: target.redPenalty,
    congestionPenalty: target.congestionPenalty,
    recentlyVisitedPenalty: target.recentlyVisitedPenalty,
    sameTargetPenalty: target.sameTargetPenalty
  };
}

export function compactSequence(sequence = []) {
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

function compactCandidateDiagnostics(diagnostics = [], limit = 10) {
  if (!Array.isArray(diagnostics)) return [];
  const max = Math.max(1, Math.round(Number(limit) || 10));
  const compact = diagnostics.slice(0, max);
  if (diagnostics.length <= max) return compact;
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

function positionKey(position) {
  const p = copyPosition(position);
  return `${p.x},${p.y}`;
}

function manhattan(a, b) {
  return Math.abs(Math.round(Number(a.x)) - Math.round(Number(b.x))) + Math.abs(Math.round(Number(a.y)) - Math.round(Number(b.y)));
}

export class AgentLoop {
  constructor(socket, beliefs, config) {
    this.socket = socket;
    this.beliefs = beliefs;
    this.config = config;
    this.logger = createLogger(config.logLevel);
    this.telemetry = createTelemetry(config);
    this.executor = new Executor(socket, beliefs, config, this.telemetry, this.logger);
    this.currentRoutePlan = null;
    this.currentExecutablePlan = null;
    this.actionIndex = 0;
    this.lastPlanTime = -Infinity;
    this.timer = null;
    this.ticking = false;
    this.started = false;
    this.lastFailedMoveKey = null;
    this.consecutiveMoveFailures = 0;
    this.lastBlockedMoveKey = null;
    this.sameBlockedMoveCount = 0;
    this.lastOpportunisticCheckTick = -Infinity;
    this.lastReplanCause = "missing_plan";
    this.invalidNonIdleZeroActionCount = 0;
    this.pendingEvents = new Map();
    this.pendingEventsSinceMs = null;
    this.lastEventBatchMs = -Infinity;
    this.lastReplanWallClockMs = -Infinity;
    this.lastImmediatePickupMs = 0;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.logger.info("agent loop started");
    const interval = Math.max(20, Number(this.config.actionDelayMs ?? 30));
    this.timer = setInterval(() => {
      void this.tick();
    }, interval);
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.started = false;
    this.logger.warn("agent loop stopped");
  }

  enemyRelevantToCurrentPlan(lookahead = 3) {
    if (!this.currentExecutablePlan) return false;

    const dangerCells = new Set(
      this.currentExecutablePlan
        .slice(this.actionIndex)
        .filter((action) => action.type === "move")
        .slice(0, lookahead)
        .map((action) => `${action.to.x},${action.to.y}`)
    );

    for (const enemy of this.beliefs.agents.values()) {
      if (enemy.confidence < 0.4) continue;
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
    if (this.currentRoutePlan?.mode !== "SCOUT") return;
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
    const ignoredLimit = Math.max(1, Math.round(Number(this.config.planner.ignoredVisiblePackagesLimit ?? 10)));
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
      if (ignoredVisiblePackages.length >= ignoredLimit) continue;

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

  queueEvents(events = []) {
    const now = Date.now();
    for (const event of events) {
      const type = eventType(event);
      if (!type) continue;
      const current = this.pendingEvents.get(type) ?? {
        type,
        count: 0,
        payload: {},
        firstCreatedAt: event?.createdAt ?? now,
        lastCreatedAt: event?.createdAt ?? now
      };
      current.count += eventCount(event);
      current.lastCreatedAt = event?.createdAt ?? now;
      const payload = typeof event === "object" ? event.payload ?? {} : {};
      current.payload = {
        ...current.payload,
        ...payload,
        count: Math.max(Number(current.payload.count ?? 0), Number(payload.count ?? 0))
      };
      this.pendingEvents.set(type, current);
    }
    if (events.length > 0 && this.pendingEventsSinceMs === null) {
      this.pendingEventsSinceMs = now;
    }
  }

  hasPendingHardEvent() {
    for (const type of this.pendingEvents.keys()) {
      if (HARD_REPLAN_EVENTS.has(type) || type === "NEW_PACKAGE_SPAWN") return true;
    }
    return false;
  }

  flushPendingEvents({ force = false } = {}) {
    if (this.pendingEvents.size === 0) return [];
    const now = Date.now();
    const coalesceMs = Math.max(0, Number(this.config.planner.eventCoalesceMs ?? 0));
    const elapsed = this.pendingEventsSinceMs === null ? Infinity : now - this.pendingEventsSinceMs;
    if (!force && coalesceMs > 0 && elapsed < coalesceMs && !this.hasPendingHardEvent()) {
      return [];
    }

    const batch = [...this.pendingEvents.values()].map((entry) => ({
      type: entry.type,
      count: entry.count,
      payload: { ...entry.payload },
      createdAt: entry.firstCreatedAt,
      lastCreatedAt: entry.lastCreatedAt,
      batched: true
    }));
    this.pendingEvents.clear();
    this.pendingEventsSinceMs = null;
    this.lastEventBatchMs = now;
    return batch;
  }

  currentPlanIsUsable() {
    if (!this.currentRoutePlan || !this.currentExecutablePlan) return false;
    if (this.actionIndex >= this.currentExecutablePlan.length) return false;
    if (!routePathIsExecutable(this.currentRoutePlan)) return false;
    return Boolean(this.currentExecutablePlan[this.actionIndex]);
  }

  replanThrottleActive(events = []) {
    if (!this.currentPlanIsUsable()) return false;
    if (hasEvent(events, HARD_REPLAN_EVENTS)) return false;
    if (this.hasRelevantPackageEvent(events)) return false;

    const interval = SCOUT_PLAN_MODES.has(this.currentRoutePlan?.mode)
      ? Number(this.config.planner.minScoutReplanIntervalMs ?? 0)
      : Number(this.config.planner.minReplanIntervalMs ?? 0);
    if (interval <= 0) return false;
    return Date.now() - this.lastReplanWallClockMs < interval;
  }

  hasNearbyVisiblePackageCheap() {
    if (!this.beliefs.me) return false;
    const current = copyPosition(this.beliefs.me);
    const maxDistance = Number(this.config.planner.nearbyPickupMaxDistance ?? 3);
    const minConfidence = Number(this.config.planner.minParcelConfidence ?? 0.3);
    const minValue = Number(this.config.planner.nearbyPickupMinEstimatedValue ?? 1);

    for (const parcel of this.beliefs.parcels.values()) {
      if (parcel.carriedBy) continue;
      const confidence = Number(parcel.confidence ?? 0);
      const lastSeenTime = Number(parcel.lastSeenTime ?? -Infinity);
      const visible = confidence >= 1 || lastSeenTime >= Number(this.beliefs.time ?? 0);
      if (!visible || confidence < minConfidence) continue;
      if (this.beliefs.estimateParcelReward(parcel) < minValue) continue;
      if (manhattan(current, parcel) <= maxDistance) return true;
    }

    return false;
  }

  hasRelevantPackageEvent(events = []) {
    if (hasVisibleParcelEvent(events) && this.hasNearbyVisiblePackageCheap()) return true;
    if (events.some((event) => eventType(event) === "NEW_PACKAGE_SPAWN" && !Number.isFinite(Number(event?.payload?.x)))) {
      return true;
    }
    if (!this.beliefs.me) return false;
    const current = copyPosition(this.beliefs.me);
    const maxDistance = Number(this.config.planner.nearbyPickupMaxDistance ?? 3);

    return events.some((event) => {
      if (eventType(event) !== "NEW_PACKAGE_SPAWN") return false;
      const payload = event?.payload ?? {};
      const hasCoordinates = Number.isFinite(Number(payload.x)) && Number.isFinite(Number(payload.y));
      if (!hasCoordinates) return true;
      return manhattan(current, { x: Number(payload.x), y: Number(payload.y) }) <= maxDistance;
    });
  }

  boundPlannerStateForFastMode(plannerState) {
    if (!this.config.planner.fastCloudMode) return plannerState;
    const config = this.config.planner;
    const maxVisible = Math.max(1, Math.round(Number(config.maxVisiblePackageCandidates ?? 12)));
    const maxBelief = Math.max(1, Math.round(Number(config.maxBeliefPackageCandidates ?? 16)));
    const maxGreen = Math.max(1, Math.round(Number(config.maxGreenCandidates ?? 12)));
    const me = plannerState.me?.position ?? { x: 0, y: 0 };

    const withPackage = [];
    const withoutPackage = [];
    for (const green of plannerState.greens ?? []) {
      if (green.package && !green.package.carriedBy) withPackage.push(green);
      else withoutPackage.push(green);
    }

    const visible = withPackage
      .filter((green) => Number(green.package?.confidence ?? 0) >= 1 || Number(green.package?.lastSeenTime ?? -Infinity) >= Number(plannerState.time ?? 0))
      .sort((a, b) => manhattan(me, a.position) - manhattan(me, b.position));
    const visibleIds = new Set(visible.slice(0, maxVisible).map((green) => green.id));
    const belief = withPackage
      .filter((green) => !visibleIds.has(green.id))
      .sort((a, b) => {
        const rewardDelta = Number(b.package?.reward ?? b.package?.value ?? 0) - Number(a.package?.reward ?? a.package?.value ?? 0);
        return rewardDelta || manhattan(me, a.position) - manhattan(me, b.position);
      })
      .slice(0, maxBelief);
    const scoutGreens = withoutPackage
      .sort((a, b) => manhattan(me, a.position) - manhattan(me, b.position))
      .slice(0, maxGreen);
    const selected = [...visible.slice(0, maxVisible), ...belief, ...scoutGreens];
    const selectedById = new Map(selected.map((green) => [green.id, green]));

    return {
      ...plannerState,
      greens: [...selectedById.values()],
      params: {
        ...plannerState.params,
        maxCandidateGreens: Math.min(Number(plannerState.params?.maxCandidateGreens ?? maxVisible), maxVisible),
        topK: Math.min(Number(plannerState.params?.topK ?? maxVisible), maxVisible),
        beamWidth: Math.min(Number(plannerState.params?.beamWidth ?? 12), 12),
        maxPickupsBeforeDelivery: Math.min(Number(plannerState.params?.maxPickupsBeforeDelivery ?? 3), 3)
      },
      boundedInput: true,
      originalGreenCount: plannerState.greens?.length ?? 0
    };
  }

  resetMoveFailures() {
    this.lastFailedMoveKey = null;
    this.consecutiveMoveFailures = 0;
    this.lastBlockedMoveKey = null;
    this.sameBlockedMoveCount = 0;
  }

  carriedValueEstimate() {
    let value = 0;
    for (const parcel of this.beliefs.carriedParcels.values()) {
      value += Number(parcel.valueAtPickup ?? parcel.reward ?? parcel.value ?? 0);
    }
    return value;
  }

  movesUntilPutDown() {
    if (!Array.isArray(this.currentExecutablePlan)) return Infinity;
    let moves = 0;
    for (const action of this.currentExecutablePlan.slice(this.actionIndex)) {
      if (action.type === "move") moves += 1;
      if (action.type === "put_down") return moves;
    }
    return Infinity;
  }

  currentPlanTargetsParcel(parcelId) {
    const id = String(parcelId);
    if (this.currentRoutePlan?.sequence?.includes(`P_${id}`)) return true;
    return (this.currentRoutePlan?.candidateGreens ?? []).some((green) => String(green.package?.id) === id);
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
    if (routePlan?.mode === "IDLE" || routePlan?.mode === "LOCAL_EXPLORE" || routePlan?.mode === "LOCAL_EXPLORE_FAST") {
      return true;
    }
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

  futurePathPoints() {
    const points = [];
    const currentPosition = this.beliefs.me ? { x: this.beliefs.me.x, y: this.beliefs.me.y } : null;
    if (currentPosition) points.push(copyPosition(currentPosition));

    for (const action of this.currentExecutablePlan?.slice(this.actionIndex) ?? []) {
      if (action.type === "move" && action.to) points.push(copyPosition(action.to));
    }

    return points;
  }

  hasNearbyOpportunisticParcel(pathPoints = this.futurePathPoints()) {
    if (!this.beliefs.me) return false;

    const config = this.config.planner;
    const currentPosition = copyPosition(this.beliefs.me);
    const maxDistance = Number(config.opportunisticMaxDistance ?? 3);
    const pathRadius = Number(config.opportunisticPathRadius ?? 2);
    const minConfidence = Number(config.minParcelConfidence ?? 0.3);

    for (const parcel of this.beliefs.parcels.values()) {
      if (parcel.carriedBy) continue;
      if (Number(parcel.confidence ?? 0) < minConfidence) continue;
      if (this.beliefs.estimateParcelReward(parcel) <= 0) continue;
      if (this.currentPlanTargetsParcel(parcel.id)) continue;

      const parcelPosition = copyPosition(parcel);
      if (manhattan(currentPosition, parcelPosition) <= maxDistance) return true;
      if (pathPoints.some((point) => manhattan(point, parcelPosition) <= pathRadius)) return true;
    }

    return false;
  }

  shouldCheckOpportunisticPickup(events = [], pathPoints = this.futurePathPoints()) {
    if (this.currentRoutePlan?.mode === "OPPORTUNISTIC_PICKUP") return false;
    if (!this.hasNearbyOpportunisticParcel(pathPoints)) return false;

    const tick = Number(this.telemetry.tick ?? 0);
    const interval = Number(this.config.planner.opportunisticCheckIntervalTicks ?? 2);
    const recentParcelEvent = events.some((event) => {
      const type = eventType(event);
      return type === "NEW_PACKAGE_SPAWN" || type === "PARCELS_SENSING";
    });

    return recentParcelEvent || tick - this.lastOpportunisticCheckTick >= interval;
  }

  enemyRacePenalty(parcelPosition, myDistance, config) {
    let penalty = 0;
    for (const enemy of this.beliefs.agents.values()) {
      if (enemy.confidence < 0.5) continue;
      const enemyPosition = { x: Math.round(Number(enemy.x)), y: Math.round(Number(enemy.y)) };
      const enemyDistance = manhattan(enemyPosition, parcelPosition);
      if (enemyDistance + Number(config.enemySafetyMargin ?? 0) < myDistance) return Infinity;
      if (enemyDistance <= myDistance + 1) penalty += Number(config.opportunisticCongestionPenalty ?? 8);
    }
    return penalty;
  }

  findOpportunisticPickup(
    currentRoutePlan = this.currentRoutePlan,
    currentExecutablePlan = this.currentExecutablePlan,
    pathPoints = this.futurePathPoints()
  ) {
    if (!this.beliefs.me || !currentRoutePlan || !currentExecutablePlan) return null;
    if (currentRoutePlan.mode === "OPPORTUNISTIC_PICKUP") return null;

    const config = this.config.planner;
    const currentPosition = copyPosition(this.beliefs.me);
    const plannerState = buildPlannerState(this.beliefs, this.config);
    const profile = buildMapProfile(plannerState);
    const futureRejoinPoints = pathPoints.slice(1);
    const carriedValue = this.carriedValueEstimate();
    const movesToPutDown = this.movesUntilPutDown();
    let best = null;

    for (const parcel of this.beliefs.parcels.values()) {
      const parcelId = String(parcel.id);
      const parcelPosition = copyPosition(parcel);
      const confidence = Number(parcel.confidence ?? 0);
      const reward = this.beliefs.estimateParcelReward(parcel);
      let reason = null;

      if (parcel.carriedBy) reason = "carried";
      else if (confidence < Number(config.minParcelConfidence ?? 0.3)) reason = "low_confidence";
      else if (reward <= 0) reason = "zero_reward";
      else if (this.currentPlanTargetsParcel(parcelId)) reason = "already_in_plan";

      const currentDistanceCheap = manhattan(currentPosition, parcelPosition);
      const pathProximity = Math.min(...pathPoints.map((point) => manhattan(point, parcelPosition)));
      if (!reason && currentDistanceCheap > config.opportunisticMaxDistance && pathProximity > config.opportunisticPathRadius) {
        reason = "not_near_position_or_path";
      }

      if (!reason && movesToPutDown <= 2 && carriedValue >= reward) {
        reason = "near_delivery_with_high_carried_value";
      }

      const edgeToParcel = !reason
        ? shortestGridPath(plannerState, currentPosition, parcelPosition, profile)
        : { cost: Infinity, path: [] };
      if (!reason && !Number.isFinite(edgeToParcel.cost)) reason = "unreachable";

      const rejoinCandidates = futureRejoinPoints.length > 0 ? futureRejoinPoints : [currentRoutePlan.path?.at?.(-1)].filter(Boolean);
      let bestRejoin = null;
      if (!reason) {
        for (const rejoin of rejoinCandidates) {
          const direct = shortestGridPath(plannerState, currentPosition, rejoin, profile);
          const parcelToRejoin = shortestGridPath(plannerState, parcelPosition, rejoin, profile);
          if (!Number.isFinite(direct.cost) || !Number.isFinite(parcelToRejoin.cost)) continue;
          const detourCost = edgeToParcel.cost + parcelToRejoin.cost - direct.cost;
          if (!bestRejoin || detourCost < bestRejoin.detourCost) {
            bestRejoin = { position: rejoin, direct, parcelToRejoin, detourCost };
          }
        }
        if (!bestRejoin) reason = "no_rejoin";
      }

      const congestionPenalty =
        !reason && [...this.beliefs.agents.values()].some((enemy) => {
          if (enemy.confidence < 0.5) return false;
          return manhattan({ x: Math.round(enemy.x), y: Math.round(enemy.y) }, parcelPosition) <= config.opportunisticPathRadius;
        })
          ? Number(config.opportunisticCongestionPenalty ?? 8)
          : 0;
      const enemyPenalty = !reason ? this.enemyRacePenalty(parcelPosition, edgeToParcel.cost, config) : 0;
      if (!reason && !Number.isFinite(enemyPenalty)) reason = "enemy_wins_race";

      const decayPenalty = !reason ? Number(config.decayRate ?? 0) * Math.max(0, bestRejoin.detourCost) : 0;
      const estimatedGain = !reason
        ? reward - Number(config.moveWeight ?? 1) * Math.max(0, bestRejoin.detourCost) - decayPenalty - congestionPenalty - enemyPenalty
        : -Infinity;
      const chosen = estimatedGain > Number(config.opportunisticMinGain ?? 5);

      this.logger.debug("opportunistic pickup candidate", {
        parcelId,
        reward,
        detourCost: bestRejoin?.detourCost,
        estimatedGain,
        chosen,
        reason
      });

      if (!chosen) continue;
      if (!best || estimatedGain > best.estimatedGain) {
        best = {
          parcel,
          parcelId,
          parcelPosition,
          reward,
          estimatedGain,
          detourCost: bestRejoin.detourCost,
          edgeToParcel
        };
      }
    }

    if (!best) return null;

    const targetId = `OP_${best.parcelId}`;
    const startPoint = { id: "START", type: "start", position: currentPosition };
    const parcelPoint = {
      id: targetId,
      type: "green",
      position: best.parcelPosition,
      package: {
        id: best.parcelId,
        value: best.reward,
        reward: best.reward,
        confidence: best.parcel.confidence
      }
    };
    const routePlan = {
      mode: "OPPORTUNISTIC_PICKUP",
      sequence: ["START", targetId],
      path: best.edgeToParcel.path,
      value: best.estimatedGain,
      profile,
      config,
      candidateGreens: [parcelPoint],
      scoutTarget: null,
      oracle: {
        entries: new Map([
          [
            `START->${targetId}`,
            {
              fromId: "START",
              toId: targetId,
              cost: best.edgeToParcel.cost,
              path: best.edgeToParcel.path
            }
          ]
        ]),
        points: [startPoint, parcelPoint],
        pointsById: new Map([
          ["START", startPoint],
          [targetId, parcelPoint]
        ]),
        profile
      },
      state: plannerState,
      generatedAtTime: this.beliefs.time,
      opportunistic: {
        parcelId: best.parcelId,
        reward: best.reward,
        detourCost: best.detourCost,
        estimatedGain: best.estimatedGain
      }
    };
    const executablePlan = buildExecutablePlan(routePlan);
    if (executablePlan.length === 0) return null;

    this.logger.info("opportunistic pickup chosen", routePlan.opportunistic);
    this.telemetry.record("opportunistic_pickup", {
      mode: routePlan.mode,
      target: best.parcelPosition,
      actionCount: executablePlan.length,
      ...routePlan.opportunistic
    });

    return { routePlan, executablePlan };
  }

  tryImmediateNearbyPickup(plannerState = null) {
    const config = this.config.planner;
    if (config.enableImmediateNearbyPickup === false || !this.beliefs.me) return null;
    if (!this.hasNearbyVisiblePackageCheap()) return null;

    const startedAt = Date.now();
    const state = plannerState ?? buildPlannerState(this.beliefs, this.config);
    const profile = buildMapProfile(state);
    const currentPosition = copyPosition(state.me.position);
    const maxDistance = Number(config.nearbyPickupMaxDistance ?? 3);
    const maxCandidates = Math.max(1, Math.round(Number(config.nearbyPickupMaxCandidates ?? 8)));
    const minConfidence = Number(config.minParcelConfidence ?? 0.3);
    const normalMinValue = Number(config.nearbyPickupMinEstimatedValue ?? 1);
    const deliveryPreemptMinValue = Number(config.opportunisticMinValue ?? 5);
    const deliveryPreemptMaxExtra = Number(config.opportunisticMaxExtraCost ?? 3);
    const carrying = (state.carriedPackages ?? []).length > 0;
    const deliveryOnly = this.currentRoutePlan?.mode === "DELIVERY_ONLY";
    let best = null;

    const candidates = (state.greens ?? [])
      .filter((green) => {
        if (!green.package || green.package.carriedBy) return false;
        const confidence = Number(green.package.confidence ?? 0);
        const lastSeenTime = Number(green.package.lastSeenTime ?? -Infinity);
        const visible = confidence >= 1 || lastSeenTime >= Number(state.time ?? 0);
        if (!visible || confidence < minConfidence) return false;
        return Number(green.package.reward ?? green.package.value ?? 0) > 0;
      })
      .sort((a, b) => manhattan(currentPosition, a.position) - manhattan(currentPosition, b.position))
      .slice(0, maxCandidates);

    for (const green of candidates) {
      if (manhattan(currentPosition, green.position) > maxDistance) continue;
      const edgeToGreen = shortestGridPath(state, currentPosition, green.position, profile);
      if (!Number.isFinite(edgeToGreen.cost) || edgeToGreen.cost > maxDistance) continue;

      let bestRed = null;
      let bestRedEdge = null;
      let bestRedDistance = state.reds?.length > 0 ? Infinity : 0;
      for (const red of state.reds ?? []) {
        const redEdge = shortestGridPath(state, green.position, red.position, profile);
        if (Number.isFinite(redEdge.cost) && redEdge.cost < bestRedDistance) {
          bestRedDistance = redEdge.cost;
          bestRed = red;
          bestRedEdge = redEdge;
        }
      }
      if (!Number.isFinite(bestRedDistance)) continue;

      const reward = Number(green.package.reward ?? green.package.value ?? config.meanPackageValue ?? 0);
      const decayRate = Number(green.package.decayRate ?? config.decayRate ?? 0);
      const enemyPenalty = this.enemyRacePenalty(green.position, edgeToGreen.cost, config);
      if (!Number.isFinite(enemyPenalty)) continue;
      const estimatedDeliveredValue = reward - decayRate * (edgeToGreen.cost + bestRedDistance) - enemyPenalty;
      const priority = estimatedDeliveredValue / (1 + edgeToGreen.cost + bestRedDistance);
      const requiredValue = deliveryOnly && carrying ? deliveryPreemptMinValue : normalMinValue;
      if (estimatedDeliveredValue < requiredValue) continue;
      if (deliveryOnly && carrying && edgeToGreen.cost > deliveryPreemptMaxExtra) continue;

      const score = priority + estimatedDeliveredValue;
      if (!best || score > best.score || (Math.abs(score - best.score) <= 1e-9 && edgeToGreen.cost < best.edge.cost)) {
        best = { green, edge: edgeToGreen, red: bestRed, redEdge: bestRedEdge, reward, estimatedDeliveredValue, priority, score };
      }
    }

    if (!best) {
      this.lastImmediatePickupMs = Date.now() - startedAt;
      return null;
    }

    const targetId = best.green.id;
    const startPoint = { id: "START", type: "start", position: currentPosition };
    const greenPoint = {
      id: targetId,
      type: "green",
      position: copyPosition(best.green.position),
      package: best.green.package
    };
    const allowImmediateDeliveryContinuation = Number(config.maxPickupsBeforeDelivery ?? 1) > 0;
    const hasRedContinuation =
      allowImmediateDeliveryContinuation && best.red && best.redEdge && Number.isFinite(best.redEdge.cost);
    const redId = hasRedContinuation ? best.red.id : null;
    const sequence = hasRedContinuation ? ["START", targetId, redId] : ["START", targetId];
    const path = hasRedContinuation
      ? [...best.edge.path, ...best.redEdge.path.slice(1)].map(copyPosition)
      : best.edge.path.map(copyPosition);
    const redPoint = hasRedContinuation
      ? { id: redId, type: "red", position: copyPosition(best.red.position) }
      : null;
    const entries = new Map([
      [
        `START->${targetId}`,
        {
          fromId: "START",
          toId: targetId,
          cost: best.edge.cost,
          path: best.edge.path
        }
      ]
    ]);
    if (hasRedContinuation) {
      entries.set(`${targetId}->${redId}`, {
        fromId: targetId,
        toId: redId,
        cost: best.redEdge.cost,
        path: best.redEdge.path
      });
    }
    const points = hasRedContinuation ? [startPoint, greenPoint, redPoint] : [startPoint, greenPoint];
    const pointsById = new Map(points.map((point) => [point.id, point]));
    const routePlan = {
      mode: hasRedContinuation ? "PICKUP_DELIVERY" : "PICKUP_ONLY",
      sequence,
      path,
      value: best.estimatedDeliveredValue,
      profile,
      config: { ...state.params, ...config },
      candidateGreens: [greenPoint],
      scoutTarget: null,
      oracle: {
        entries,
        points,
        pointsById,
        profile
      },
      state,
      generatedAtTime: this.beliefs.time,
      fallbackStage: "immediate_nearby_pickup",
      nearbyPickup: {
        parcelId: best.green.package.id,
        reward: best.reward,
        pickupDistance: best.edge.cost,
        estimatedDeliveredValue: best.estimatedDeliveredValue,
        priority: best.priority
      }
    };
    const executablePlan = routePathIsExecutable(routePlan) ? buildExecutablePlan(routePlan) : [];
    this.lastImmediatePickupMs = Date.now() - startedAt;
    if (executablePlan.length === 0) return null;

    this.logger.info("immediate nearby pickup chosen", routePlan.nearbyPickup);
    this.telemetry.record("immediate_nearby_pickup", {
      mode: routePlan.mode,
      target: best.green.position,
      actionCount: executablePlan.length,
      immediatePickupMs: this.lastImmediatePickupMs,
      ...routePlan.nearbyPickup
    });

    return { routePlan, executablePlan };
  }

  mustReplan(events = []) {
    const decide = (should, cause) => {
      this.lastReplanCause = cause;
      return should;
    };

    if (!this.currentRoutePlan || !this.currentExecutablePlan) return decide(true, "missing_plan");

    if (this.replanThrottleActive(events)) return decide(false, "replan_throttled");

    if (this.actionIndex >= this.currentExecutablePlan.length) {
      if (isStartOnlyPlan(this.currentRoutePlan, this.currentExecutablePlan)) {
        if (hasEvent(events, HARD_REPLAN_EVENTS)) return decide(true, "hard_event");
        if (this.hasRelevantPackageEvent(events)) return decide(true, hasVisibleParcelEvent(events) ? "parcel_visible" : "new_package");
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
      if (this.hasRelevantPackageEvent(events)) return decide(true, hasVisibleParcelEvent(events) ? "parcel_visible" : "new_package");
      if (hasAgentSensing && this.enemyRelevantToCurrentPlan()) return decide(true, "enemy_relevant");
      return decide(false, "scout_commitment_keep_plan");
    }

    if (hasAgentSensing && this.enemyRelevantToCurrentPlan()) return decide(true, "enemy_relevant");
    if (hasEvent(events, HARD_REPLAN_EVENTS)) return decide(true, "hard_event");
    if (this.hasRelevantPackageEvent(events)) return decide(true, hasVisibleParcelEvent(events) ? "parcel_visible" : "new_package");

    const periodic = Number(this.currentRoutePlan.config?.periodicReplanTicks ?? this.config.planner.periodicReplanTicks);
    if (periodic > 0 && this.beliefs.time - this.lastPlanTime >= periodic) return decide(true, "periodic");

    return decide(false, "no_replan");
  }

  makePlan(events = []) {
    const planningStartedAt = Date.now();
    const plannerStateStartedAt = Date.now();
    const rawPlannerState = buildPlannerState(this.beliefs, this.config);
    const plannerStateFinishedAt = Date.now();
    const immediatePickupStartedAt = Date.now();
    const immediatePickup = this.tryImmediateNearbyPickup(rawPlannerState);
    const immediatePickupFinishedAt = Date.now();
    const immediatePickupMs = immediatePickupFinishedAt - immediatePickupStartedAt;
    const plannerState = immediatePickup ? rawPlannerState : this.boundPlannerStateForFastMode(rawPlannerState);
    const plannerSummary = {
      width: plannerState.width,
      height: plannerState.height,
      greens: plannerState.greens.length,
      greensWithPackage: plannerState.greens.filter((green) => green.package).length,
      reds: plannerState.reds.length,
      parcelsInBelief: this.beliefs.parcels.size,
      carried: this.beliefs.carriedParcels.size,
      temporaryBlockedCells: this.beliefs.temporaryBlockedCells?.size ?? 0,
      me: this.beliefs.me
    };
    const replanStartedAt = Date.now();
    let routePlan = immediatePickup?.routePlan ?? replan(plannerState);
    if (immediatePickup) this.lastReplanCause = "immediate_nearby_pickup";
    let replanFinishedAt = Date.now();
    let replanMs = immediatePickup ? 0 : replanFinishedAt - replanStartedAt;
    if (
      !immediatePickup &&
      this.config.planner.fastCloudMode &&
      routePlan?.fallbackStage !== "hard_budget_fallback" &&
      replanMs > Number(this.config.planner.hardPlanningBudgetMs ?? 60)
    ) {
      const fallbackStartedAt = Date.now();
      routePlan = fallbackFastPlan(plannerState, this.config.planner, {
        fallbackStage: "hard_budget_fallback"
      });
      replanFinishedAt = Date.now();
      replanMs += replanFinishedAt - fallbackStartedAt;
    }
    const executableStartedAt = Date.now();
    let executablePlan = immediatePickup?.executablePlan ?? (routePathIsExecutable(routePlan) ? buildExecutablePlan(routePlan) : []);
    const executableFinishedAt = Date.now();
    const buildPlannerStateMs = plannerStateFinishedAt - plannerStateStartedAt;
    const buildExecutablePlanMs = executableFinishedAt - executableStartedAt;
    const totalPlanningMs = executableFinishedAt - planningStartedAt;
    const elapsed = totalPlanningMs;
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
    this.lastReplanWallClockMs = Date.now();
    if (executablePlan.length > 0) this.invalidNonIdleZeroActionCount = 0;
    this.beliefs.clearDirty();
    if (SCOUT_PLAN_MODES.has(routePlan.mode) && routePlan.scoutTarget?.id) {
      this.beliefs.markScoutTargetAttempt?.(routePlan.scoutTarget.id, this.beliefs.time);
    }

    const eventsSeen = summarizeEvents(events);
    const replanCause = this.lastReplanCause ?? "missing_plan";
    const candidateIds = (routePlan.candidateGreens ?? []).map((green) => green.id);
    const candidateLimit = Math.max(1, Math.round(Number(routePlan.config?.candidateDiagnosticsLimit ?? 10)));
    const candidates =
      candidateIds.length > candidateLimit
        ? `${candidateIds.slice(0, candidateLimit).join(",")},...(${candidateIds.length})`
        : candidateIds.join(",");
    const scoutTarget = summarizeScoutTarget(routePlan.scoutTarget);
    const sequenceSummary = compactSequence(routePlan.sequence);
    const candidateDiagnostics = compactCandidateDiagnostics(
      routePlan.candidateDiagnostics,
      routePlan.config?.candidateDiagnosticsLimit ?? this.config.planner.candidateDiagnosticsLimit
    );
    const visiblePackageSummary = this.summarizeVisiblePackages(routePlan);
    this.logger.info("replan", {
      eventsSeen,
      replanCause,
      buildPlannerStateMs,
      immediatePickupMs,
      replanMs,
      buildExecutablePlanMs,
      totalPlanningMs,
      mode: routePlan.mode,
      sequence: sequenceSummary.text,
      sequenceLength: sequenceSummary.sequenceLength,
      sequenceTruncated: sequenceSummary.truncated,
      value: routePlan.value,
      actions: executablePlan.length,
      nearbyPickupChosen: Boolean(immediatePickup),
      candidates,
      invalidPlanDetected: Boolean(routePlan.invalidPlanDetected),
      fallbackStage: routePlan.fallbackStage ?? "full_plan",
      hasDirectionalTiles: Boolean(routePlan.hasDirectionalTiles ?? routePlan.profile?.hasDirectionalTiles),
      directedDistanceFieldsBuilt: Boolean(routePlan.directedDistanceFieldsBuilt),
      candidateDiagnostics,
      ...visiblePackageSummary,
      scoutTarget,
      oraclePoints: routePlan.oracle?.points?.length ?? 0,
      oraclePathfindingCalls: routePlan.oracle?.stats?.pathfindingCalls ?? 0,
      oracleSingleSourceBfsRuns: routePlan.oracle?.stats?.singleSourceBfsRuns ?? 0,
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
      buildPlannerStateMs,
      immediatePickupMs,
      replanMs,
      buildExecutablePlanMs,
      totalPlanningMs,
      planningTimeMs: elapsed,
      temporaryBlockedCells: this.beliefs.temporaryBlockedCells?.size ?? 0,
      scoutTarget: compactScoutTargetId(routePlan.scoutTarget?.id),
      scoutTargetDetails: scoutTarget,
      scoutInfoValue: routePlan.scoutTarget?.infoValue,
      candidateCount: routePlan.candidateGreens?.length ?? 0,
      invalidPlanDetected: Boolean(routePlan.invalidPlanDetected),
      fallbackStage: routePlan.fallbackStage ?? "full_plan",
      hasDirectionalTiles: Boolean(routePlan.hasDirectionalTiles ?? routePlan.profile?.hasDirectionalTiles),
      directedDistanceFieldsBuilt: Boolean(routePlan.directedDistanceFieldsBuilt),
      candidateDiagnostics,
      ...visiblePackageSummary,
      oraclePoints: routePlan.oracle?.points?.length ?? 0,
      oraclePathfindingCalls: routePlan.oracle?.stats?.pathfindingCalls ?? 0,
      oracleSingleSourceBfsRuns: routePlan.oracle?.stats?.singleSourceBfsRuns ?? 0,
      actionCount: executablePlan.length,
      nearbyPickupChosen: Boolean(immediatePickup),
      eventsSeen,
      replanCause,
      reason: replanCause
    });

    if (elapsed > Number(this.config.planner.planningBudgetMs ?? this.config.planner.maxPlanningTimeMs ?? 30)) {
      this.logger.warn("planning_exceeded_budget", {
        buildPlannerStateMs,
        immediatePickupMs,
        replanMs,
        buildExecutablePlanMs,
        totalPlanningMs: elapsed,
        budgetMs: this.config.planner.planningBudgetMs
      });
    }
    if (elapsed > Number(this.config.planner.hardPlanningBudgetMs ?? 100)) {
      this.logger.warn("hard_planning_budget_exceeded", {
        buildPlannerStateMs,
        immediatePickupMs,
        replanMs,
        buildExecutablePlanMs,
        totalPlanningMs: elapsed,
        budgetMs: this.config.planner.hardPlanningBudgetMs,
        fallbackStage: routePlan.fallbackStage
      });
    }
  }

  invalidatePlan(reason) {
    this.logger.warn("invalidate plan", reason);
    this.currentRoutePlan = null;
    this.currentExecutablePlan = null;
    this.actionIndex = 0;
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;

    try {
      this.telemetry.nextTick();
      if (typeof this.beliefs.advanceTimeFromClock === "function") {
        this.beliefs.advanceTimeFromClock();
      } else {
        this.beliefs.advanceTime();
      }
      const rawEvents = this.beliefs.consumeEvents();
      this.queueEvents(rawEvents);
      if (!this.beliefs.ready) return;
      const forceEventBatch =
        !this.currentRoutePlan ||
        this.hasPendingHardEvent() ||
        this.hasNearbyVisiblePackageCheap();
      const events = this.flushPendingEvents({ force: forceEventBatch });

      const immediatePickup = this.tryImmediateNearbyPickup();
      if (immediatePickup) {
        this.currentRoutePlan = immediatePickup.routePlan;
        this.currentExecutablePlan = immediatePickup.executablePlan;
        this.actionIndex = 0;
        this.lastPlanTime = this.beliefs.time;
        this.lastReplanWallClockMs = Date.now();
        this.lastReplanCause = "immediate_nearby_pickup";
      }

      if (!immediatePickup && this.mustReplan(events)) {
        this.makePlan(events);
      }

      if (!this.currentRoutePlan || !this.currentExecutablePlan) return;

      const pathPoints = this.futurePathPoints();
      if (this.shouldCheckOpportunisticPickup(events, pathPoints)) {
        this.lastOpportunisticCheckTick = Number(this.telemetry.tick ?? 0);
        const opportunistic = this.findOpportunisticPickup(this.currentRoutePlan, this.currentExecutablePlan, pathPoints);
        if (opportunistic) {
          this.currentRoutePlan = opportunistic.routePlan;
          this.currentExecutablePlan = opportunistic.executablePlan;
          this.actionIndex = 0;
        }
      }

      const action = this.currentExecutablePlan?.[this.actionIndex];
      if (!action) {
        if (this.isInvalidTargetZeroAction(this.currentRoutePlan, this.currentExecutablePlan)) {
          this.rejectInvalidZeroActionPlan(this.currentRoutePlan);
          return;
        }
        if (isStartOnlyPlan(this.currentRoutePlan, this.currentExecutablePlan)) {
          return;
        }
        if (this.canUseFallbackExploration(this.currentRoutePlan)) {
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

      if (action.type === "move" && action.to && this.enemyOccupies(action.to)) {
        const blockedMode = this.currentRoutePlan?.mode;
        const repeated = this.recordBlockedMove(action, "enemy_in_next_cell");
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

      const ok = await this.executor.execute(action);
      if (ok === false) {
        if (action.type === "move") {
          const failures = this.recordMoveFailure(action);
          const repeatedLimit = Number(this.config.planner.maxRepeatedBlockedMovesBeforeReplan ?? 2);
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
        this.invalidatePlan("action_failed");
        return;
      }

      if (action.type === "move") {
        this.resetMoveFailures();
        this.markScoutTargetVisitedIfInRange();
      }

      this.actionIndex += 1;
      if (this.actionIndex >= this.currentExecutablePlan.length) {
        if (this.currentRoutePlan?.mode === "SCOUT" && this.currentRoutePlan.scoutTarget) {
          this.beliefs.markScoutVisited(
            this.currentRoutePlan.scoutTarget.id,
            this.currentRoutePlan.scoutTarget.position
          );
        }
        this.telemetry.record("plan_completed", {
          mode: this.currentRoutePlan?.mode,
          sequence: compactSequence(this.currentRoutePlan?.sequence).text,
          scoutTarget: compactScoutTargetId(this.currentRoutePlan?.scoutTarget?.id),
          currentPosition: this.beliefs.me ? { x: this.beliefs.me.x, y: this.beliefs.me.y } : null
        });
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
