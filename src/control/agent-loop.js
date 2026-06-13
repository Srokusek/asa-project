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
import { normalizeSensingRange } from "../state/belief-state.js";
import { createTelemetry } from "../telemetry/telemetry.js";
import { createLogger } from "../utils/logger.js";
import { directionFromPositions, manhattan, positionKey, sameTile } from "../utils/geometry.js";
import { createChatProcessor } from "../llm/chat-processor.js";
import { createAgentLoopDiagnostics } from "../llm/diagnostics.js";

const HARD_REPLAN_EVENTS = new Set([
  "MOVE_FAILED",
  "PATH_BLOCKED",
  "PACKAGE_STOLEN",
  "TARGET_NOT_FOUND",
  "BELIEF_INVALIDATED",
  "SENSING_RANGE_UPDATED",
  "PICKUP_FAILED",
  "PUTDOWN_FAILED",
  "TEMPORARY_BLOCKED_CELL",
  "FORBIDDEN_TILE_ADDED",
  "PICKUP_MULTIPLIER_SET",
  "DELIVERY_MULTIPLIER_SET",
  "DELIVERY_COUNT_MULTIPLIER_SET",
  "ORCHESTRATION_RULES_REPLACED"
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
  "SCOUT_UNIFIED"
]);

function eventType(event) {
  return typeof event === "string" ? event : event?.type;
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

function hasOrchestrationPickupEvent(events, beliefs) {
  if (!beliefs?.orchestration?.activeRuleId) return false;
  return events.some((event) => eventType(event) === "PICK_PACKAGE");
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

function isWaitingManualTask(task) {
  return task?.priority === "sticky_until_done" && task?.payload?.waitAtTarget === true;
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
    this.diagnostics = createAgentLoopDiagnostics({ logger: this.logger, telemetry: this.telemetry, config: this.config });
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
    this.lastReplanCause = "missing_plan";
    this.invalidNonIdleZeroActionCount = 0;
    this.chatProcessor = this.config.llm?.chatEnabled
      ? createChatProcessor({ beliefs: this.beliefs, executor: this.executor, logger: this.logger, config: this.config })
      : null;
    this.activeManualTask = null;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.logger.info("agent loop started");
    const interval = Math.max(20, Number(this.config.actionDelayMs ?? 30));
    this.timer = setInterval(() => {
      void this.tick();
    }, interval);
    void this.tick(); // call tick at every [interval] ms
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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

    const sensingRange = normalizeSensingRange(this.beliefs.sensingRange, this.config.planner.sensingRange ?? 0);
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
    this.diagnostics.onMoveFailed({
      beliefs: this.beliefs,
      action,
      consecutiveMoveFailures: this.consecutiveMoveFailures,
      sameBlockedMoveCount: this.sameBlockedMoveCount
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
    if (routePlan?.mode === "IDLE") return true;
    if (TARGET_PLAN_MODES.has(routePlan?.mode)) return false;
    const hasCandidates = (routePlan?.candidateGreens ?? []).length > 0;
    const hasCarried = this.beliefs.carriedParcels.size > 0;
    return !hasCandidates && !this.hasValidParcelInBelief() && !hasCarried;
  }

  isInvalidTargetZeroAction(routePlan = this.currentRoutePlan, executablePlan = this.currentExecutablePlan) {
    if (this.isManualWaitPlan(routePlan, executablePlan)) return false;
    if (!TARGET_PLAN_MODES.has(routePlan?.mode)) return false;
    if (Array.isArray(executablePlan) && executablePlan.length > 0) return false;
    return true;
  }

  isManualWaitPlan(routePlan = this.currentRoutePlan, executablePlan = this.currentExecutablePlan) {
    return (
      routePlan?.mode === "MANUAL_GOTO" &&
      isWaitingManualTask(this.activeManualTask) &&
      Array.isArray(executablePlan) &&
      executablePlan.length === 0 &&
      sameTile(routePlan?.manualTarget ?? this.activeManualTask?.payload?.target, this.activeManualTask?.payload?.target)
    );
  }

  rejectInvalidZeroActionPlan(routePlan, reason = "invalid_non_idle_zero_action") {
    this.invalidNonIdleZeroActionCount += 1;
    this.diagnostics.onInvalidZeroActionPlan({
      routePlan,
      invalidNonIdleZeroActionCount: this.invalidNonIdleZeroActionCount,
      invalidTargetPlanLimit: INVALID_TARGET_PLAN_LIMIT
    });
    this.invalidatePlan(reason);
  }

  mustReplan(events = []) {
    const decide = (should, cause) => {
      this.lastReplanCause = cause;
      return should;
    };

    if (!this.currentRoutePlan || !this.currentExecutablePlan) return decide(true, "missing_plan");

    if (hasOrchestrationPickupEvent(events, this.beliefs)) {
      return decide(true, "orchestration_pickup");
    }

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
    if (this.activeManualTask && !this.beliefs.hasManualTaskId?.(this.activeManualTask.id)) {
      this.diagnostics.onManualTaskCleared({ task: this.activeManualTask });
      this.activeManualTask = null;
      this.invalidatePlan("manual_task_cleared");
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
      this.diagnostics.onManualTaskRetry({
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
    this.diagnostics.onManualTaskStarted({
      taskId: task.id,
      routePlan,
      actionCount: this.currentExecutablePlan.length
    });
    return true;
  }

  makePlan(events = []) {
    const start = Date.now();
    const plannerState = buildPlannerState(this.beliefs, this.config);
    const routePlan = replan(plannerState);
    let executablePlan = routePathIsExecutable(routePlan) ? buildExecutablePlan(routePlan) : [];
    const elapsed = Date.now() - start;
    this.diagnostics.onPlannerStateSummary({ beliefs: this.beliefs, plannerState, routePlan });

    if (routePlan.mode !== "IDLE" && executablePlan.length === 0) {
      this.diagnostics.onNonIdleZeroActionPlan({ routePlan });

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
      this.diagnostics.onNonExecutablePath({ routePlan });
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

    this.diagnostics.onReplan({
      beliefs: this.beliefs,
      plannerState,
      routePlan,
      executablePlan,
      events,
      replanCause: this.lastReplanCause ?? "missing_plan",
      elapsedMs: elapsed
    });

    if (elapsed > this.config.planner.planningBudgetMs) {
      this.diagnostics.onPlanningExceededBudget({
        elapsedMs: elapsed,
        budgetMs: this.config.planner.planningBudgetMs
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
    this.ticking = true; // mark that a tick is in progress

    try {
      this.telemetry.nextTick();
      this.beliefs.advanceTimeFromClock();
      const events = this.beliefs.consumeEvents();
      this.diagnostics.recordBeliefEvents(events);
      // events is a list of all events that the agent has sensed since the last tick
      if (!this.beliefs.ready) return; // stop if connection, map or other crucial steps have not been resolved yet

      if (this.chatProcessor && await this.chatProcessor.processPendingChatMessage()) {
        return;
      }

      if (this.ensureManualPlan()) {
        // manual plan has priority over automatic replanning
      } else if (this.mustReplan(events)) {
        // check whether sensed events constitute to having to replan
        this.makePlan(events);
      }

      // stop if we have no executable route plan
      if (!this.currentRoutePlan || !this.currentExecutablePlan) return;

      // get the next action in plan
      const action = this.currentExecutablePlan?.[this.actionIndex];
      if (!action) {
        if (this.isManualWaitPlan(this.currentRoutePlan, this.currentExecutablePlan)) {
          return;
        }
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

      this.diagnostics.onExecuteAction({
        routePlan: this.currentRoutePlan,
        action,
        actionIndex: this.actionIndex
      });

      // take note if there is another agent in the target tile of a move action
      if (action.type === "move" && action.to && this.enemyOccupies(action.to)) {
        const repeated = this.recordBlockedMove(action, "enemy_in_next_cell");
        this.beliefs.markTemporaryBlocked(action.to, 2, "enemy_in_next_cell");
        this.diagnostics.onEnemyBlockedMove({
          beliefs: this.beliefs,
          routePlan: this.currentRoutePlan,
          action,
          repeated
        });
        this.invalidatePlan("enemy_in_next_cell");
        return;
      }

      this.diagnostics.onActionStart({
        beliefs: this.beliefs,
        routePlan: this.currentRoutePlan,
        action
      });

      const ok = await this.executor.execute(action);

      if (ok === false) {
        if (action.type === "move") {
          const failures = this.recordMoveFailure(action);
          const repeatedLimit = Number(this.config.planner.maxRepeatedBlockedMovesBeforeReplan ?? 2);
          if (this.sameBlockedMoveCount >= repeatedLimit) {
            this.diagnostics.onRepeatedBlockedMove({
              routePlan: this.currentRoutePlan,
              action,
              sameBlockedMoveCount: this.sameBlockedMoveCount,
              reason: "move_failed"
            });
          } else if (failures >= 3) {
            const sidestep = this.explorationAction();
            if (sidestep) {
              this.diagnostics.onForcedSidestep({
                action: sidestep,
                consecutiveMoveFailures: failures
              });
              await this.executor.execute(sidestep);
            }
          }
        }
        this.diagnostics.onActionFailed({
          beliefs: this.beliefs,
          routePlan: this.currentRoutePlan,
          action,
          consecutiveMoveFailures: this.consecutiveMoveFailures
        });
        if (this.currentRoutePlan?.mode === "MANUAL_GOTO" && this.activeManualTask) {
          this.diagnostics.onManualTaskRetry({
            taskId: this.activeManualTask.id,
            reason: "action_failed",
            logReason: "action_failed_replan",
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
        const waitingManualTask = isWaitingManualTask(completedManualTask);
        // if this has finished the plan:
        if (SCOUT_PLAN_MODES.has(this.currentRoutePlan?.mode) && this.currentRoutePlan.scoutTarget) {
          this.beliefs.markScoutVisited(
            this.currentRoutePlan.scoutTarget.id,
            this.currentRoutePlan.scoutTarget.position
          );
        }
        this.diagnostics.onPlanCompleted({
          beliefs: this.beliefs,
          routePlan: this.currentRoutePlan
        });
        if (completedManualTask) {
          if (waitingManualTask) {
            this.diagnostics.onManualTaskWaiting({
              task: completedManualTask,
              routePlan: this.currentRoutePlan
            });
          } else {
            this.diagnostics.onManualTaskCompleted({
              task: completedManualTask,
              routePlan: this.currentRoutePlan
            });
            this.beliefs.consumeManualTask?.();
            this.activeManualTask = null;
          }
        }
        this.invalidatePlan(waitingManualTask ? "manual_task_waiting" : "plan_completed");
      }
    } catch (error) {
      this.logger.error("loop tick failed", error);
      this.invalidatePlan("tick_exception");
    } finally {
      this.ticking = false;
    }
  }
}
