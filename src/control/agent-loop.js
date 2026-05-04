import { Executor } from "../executor/executor.js";
import { buildExecutablePlan } from "../planner/executable-plan.js";
import { buildMapProfile, isWalkable, replan, shortestGridPath } from "../planner/route-planner.js";
import { buildPlannerState } from "../state/planner-state.js";
import { createTelemetry } from "../telemetry/telemetry.js";
import { createLogger } from "../utils/logger.js";

const REPLAN_EVENTS = new Set([
  "MAP_READY",
  "TILE_UPDATED",
  "NEW_PACKAGE_SPAWN",
  "MOVE_FAILED",
  "PATH_BLOCKED",
  "PACKAGE_STOLEN",
  "TARGET_NOT_FOUND",
  "BELIEF_INVALIDATED",
  "PICKUP_FAILED",
  "PUTDOWN_FAILED"
]);

const IDLE_REPLAN_EVENTS = new Set([
  "PARCELS_SENSING",
  "NEW_PACKAGE_SPAWN",
  "MAP_READY",
  "BELIEF_INVALIDATED",
  "TILE_UPDATED"
]);

function eventType(event) {
  return typeof event === "string" ? event : event?.type;
}

function routePathIsWalkable(routePlan) {
  if (!routePlan?.state || !Array.isArray(routePlan.path)) return true;
  return routePlan.path.every((position) => isWalkable(routePlan.state, position));
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
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }

  if (counts.size === 0) return "missing_or_periodic_plan";

  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([type, count]) => `${type}x${count}`)
    .join(",");
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
    this.executor = new Executor(socket, beliefs, config, this.telemetry);
    this.currentRoutePlan = null;
    this.currentExecutablePlan = null;
    this.actionIndex = 0;
    this.lastPlanTime = -Infinity;
    this.timer = null;
    this.ticking = false;
    this.started = false;
    this.lastFailedMoveKey = null;
    this.consecutiveMoveFailures = 0;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.logger.info("agent loop started");
    const interval = Math.max(50, Number(this.config.actionDelayMs ?? 100));
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
    const candidates = [
      { direction: "right", to: { x: x + 1, y } },
      { direction: "left", to: { x: x - 1, y } },
      { direction: "up", to: { x, y: y + 1 } },
      { direction: "down", to: { x, y: y - 1 } }
    ];

    for (const candidate of candidates) {
      const tile = this.beliefs.tiles.get(`${candidate.to.x},${candidate.to.y}`);
      if (!tile) continue;
      if (String(tile.type) === "0") continue;
      if (this.beliefs.isTemporarilyBlocked?.(candidate.to)) continue;

      return {
        type: "move",
        direction: candidate.direction,
        from: { x, y },
        to: candidate.to,
        reason: "agent-loop-fallback-exploration"
      };
    }

    return null;
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

    this.logger.warn("move failed", {
      blockedCell: action.to,
      consecutiveMoveFailures: this.consecutiveMoveFailures,
      temporaryBlockedCells: this.beliefs.temporaryBlockedCells?.size ?? 0
    });

    return this.consecutiveMoveFailures;
  }

  resetMoveFailures() {
    this.lastFailedMoveKey = null;
    this.consecutiveMoveFailures = 0;
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

  futurePathPoints() {
    const points = [];
    const currentPosition = this.beliefs.me ? { x: this.beliefs.me.x, y: this.beliefs.me.y } : null;
    if (currentPosition) points.push(copyPosition(currentPosition));

    for (const action of this.currentExecutablePlan?.slice(this.actionIndex) ?? []) {
      if (action.type === "move" && action.to) points.push(copyPosition(action.to));
    }

    return points;
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

  findOpportunisticPickup(currentRoutePlan = this.currentRoutePlan, currentExecutablePlan = this.currentExecutablePlan) {
    if (!this.beliefs.me || !currentRoutePlan || !currentExecutablePlan) return null;
    if (currentRoutePlan.mode === "OPPORTUNISTIC_PICKUP") return null;

    const config = this.config.planner;
    const currentPosition = copyPosition(this.beliefs.me);
    const plannerState = buildPlannerState(this.beliefs, this.config);
    const profile = buildMapProfile(plannerState);
    const pathPoints = this.futurePathPoints();
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

  mustReplan(events = []) {
    if (!this.currentRoutePlan || !this.currentExecutablePlan) return true;
    if (this.actionIndex >= this.currentExecutablePlan.length) {
      if (isStartOnlyPlan(this.currentRoutePlan, this.currentExecutablePlan)) {
        if (events.some((event) => IDLE_REPLAN_EVENTS.has(eventType(event)))) return true;
        const periodicIdle = Number(
          this.currentRoutePlan.config?.periodicReplanTicks ?? this.config.planner.periodicReplanTicks
        );
        return periodicIdle > 0 && this.beliefs.time - this.lastPlanTime >= periodicIdle;
      }
      return true;
    }

    if (events.some((event) => eventType(event) === "AGENTS_SENSING")) {
      if (this.enemyRelevantToCurrentPlan()) return true;
    }

    if (events.some((event) => REPLAN_EVENTS.has(eventType(event)))) return true;

    const periodic = Number(this.currentRoutePlan.config?.periodicReplanTicks ?? this.config.planner.periodicReplanTicks);
    if (periodic > 0 && this.beliefs.time - this.lastPlanTime >= periodic) return true;

    return false;
  }

  makePlan(events = []) {
    const start = Date.now();
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
      me: this.beliefs.me
    };
    const routePlan = replan(plannerState);
    let executablePlan = routePathIsWalkable(routePlan) ? buildExecutablePlan(routePlan) : [];
    const elapsed = Date.now() - start;
    this.logger.debug("planner state summary", { ...plannerSummary, mode: routePlan.mode });

    if (routePlan.mode !== "IDLE" && executablePlan.length === 0) {
      this.logger.warn("non-idle plan produced zero actions", {
        mode: routePlan.mode,
        sequence: routePlan.sequence?.join(" -> ")
      });

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
      this.logger.warn("planner produced a non-executable path", { sequence: routePlan.sequence });
    }

    this.currentRoutePlan = routePlan;
    this.currentExecutablePlan = executablePlan;
    this.actionIndex = 0;
    this.lastPlanTime = this.beliefs.time;
    this.beliefs.clearDirty();

    const reason = summarizeEvents(events);
    const candidates = (routePlan.candidateGreens ?? []).map((green) => green.id).join(",");
    this.logger.info("replan", {
      reason,
      mode: routePlan.mode,
      sequence: routePlan.sequence.join(" -> "),
      value: routePlan.value,
      actions: executablePlan.length,
      candidates,
      scoutTarget: routePlan.scoutTarget?.id,
      scoutInfoValue: routePlan.scoutTarget?.infoValue,
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
      sequence: routePlan.sequence,
      expectedValue: routePlan.value,
      score: this.beliefs.me?.score,
      parcelsInBelief: this.beliefs.parcels.size,
      greensWithPackage: plannerSummary.greensWithPackage,
      carriedCount: this.beliefs.carriedParcels.size,
      planningTimeMs: elapsed,
      temporaryBlockedCells: this.beliefs.temporaryBlockedCells?.size ?? 0,
      scoutTarget: routePlan.scoutTarget?.id,
      scoutInfoValue: routePlan.scoutTarget?.infoValue,
      candidateCount: routePlan.candidateGreens?.length ?? 0,
      oraclePoints: routePlan.oracle?.points?.length ?? 0,
      oraclePathfindingCalls: routePlan.oracle?.stats?.pathfindingCalls ?? 0,
      oracleSingleSourceBfsRuns: routePlan.oracle?.stats?.singleSourceBfsRuns ?? 0,
      actionCount: executablePlan.length,
      reason
    });

    if (elapsed > this.config.planner.maxPlanningTimeMs) {
      this.logger.warn("planning exceeded budget", { elapsedMs: elapsed, budgetMs: this.config.planner.maxPlanningTimeMs });
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
      const events = this.beliefs.consumeEvents();
      if (!this.beliefs.ready) return;

      if (this.mustReplan(events)) {
        this.makePlan(events);
      }

      if (!this.currentRoutePlan || !this.currentExecutablePlan) return;

      const opportunistic = this.findOpportunisticPickup(this.currentRoutePlan, this.currentExecutablePlan);
      if (opportunistic) {
        this.currentRoutePlan = opportunistic.routePlan;
        this.currentExecutablePlan = opportunistic.executablePlan;
        this.actionIndex = 0;
      }

      const action = this.currentExecutablePlan?.[this.actionIndex];
      if (!action) {
        if (isStartOnlyPlan(this.currentRoutePlan, this.currentExecutablePlan)) {
          return;
        }
        this.invalidatePlan("plan_finished_or_empty");
        return;
      }

      this.logger.debug("execute action", {
        index: this.actionIndex,
        action,
        sequence: this.currentRoutePlan?.sequence?.join(" -> ")
      });

      if (action.type === "move" && action.to && this.enemyOccupies(action.to)) {
        const blockedMode = this.currentRoutePlan?.mode;
        this.beliefs.markTemporaryBlocked(action.to, 2, "enemy_in_next_cell");
        this.logger.warn("enemy_in_next_cell", {
          blockedCell: action.to,
          temporaryBlockedCells: this.beliefs.temporaryBlockedCells?.size ?? 0
        });
        this.telemetry.record("enemy_in_next_cell", {
          mode: blockedMode,
          currentPosition: this.beliefs.me ? { x: this.beliefs.me.x, y: this.beliefs.me.y } : null,
          action,
          result: false,
          temporaryBlockedCells: this.beliefs.temporaryBlockedCells?.size ?? 0
        });
        this.invalidatePlan("enemy_in_next_cell");
        return;
      }

      this.telemetry.record("action_start", {
        mode: this.currentRoutePlan?.mode,
        currentPosition: this.beliefs.me ? { x: this.beliefs.me.x, y: this.beliefs.me.y } : null,
        target: this.currentRoutePlan?.path?.at?.(-1) ?? null,
        sequence: this.currentRoutePlan?.sequence,
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
          if (failures >= 3) {
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
          sequence: this.currentRoutePlan?.sequence,
          scoutTarget: this.currentRoutePlan?.scoutTarget?.id,
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
