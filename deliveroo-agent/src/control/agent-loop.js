import { Executor } from "../executor/executor.js";
import { buildExecutablePlan } from "../planner/executable-plan.js";
import { isWalkable, replan } from "../planner/route-planner.js";
import { buildPlannerState } from "../state/planner-state.js";
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

export class AgentLoop {
  constructor(socket, beliefs, config) {
    this.socket = socket;
    this.beliefs = beliefs;
    this.config = config;
    this.logger = createLogger(config.logLevel);
    this.executor = new Executor(socket, beliefs, config);
    this.currentRoutePlan = null;
    this.currentExecutablePlan = null;
    this.actionIndex = 0;
    this.lastPlanTime = -Infinity;
    this.timer = null;
    this.ticking = false;
    this.started = false;
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
      elapsedMs: elapsed
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

      const ok = await this.executor.execute(action);
      if (ok === false) {
        this.invalidatePlan("action_failed");
        return;
      }

      this.actionIndex += 1;
      if (this.actionIndex >= this.currentExecutablePlan.length) {
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
