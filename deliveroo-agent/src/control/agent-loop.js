import { Executor } from "../executor/executor.js";
import { buildExecutablePlan } from "../planner/executable-plan.js";
import { isWalkable, replan } from "../planner/route-planner.js";
import { buildPlannerState } from "../state/planner-state.js";
import { createLogger } from "../utils/logger.js";

const REPLAN_EVENTS = new Set([
  "MAP_READY",
  "TILE_UPDATED",
  "NEW_PACKAGE_SPAWN",
  "AGENTS_SENSING",
  "PICK_PACKAGE",
  "DELIVER_PACKAGES",
  "MOVE_FAILED",
  "PATH_BLOCKED",
  "PACKAGE_STOLEN",
  "TARGET_NOT_FOUND",
  "BELIEF_INVALIDATED",
  "PICKUP_FAILED",
  "PUTDOWN_FAILED"
]);

function eventType(event) {
  return typeof event === "string" ? event : event?.type;
}

function routePathIsWalkable(routePlan) {
  if (!routePlan?.state || !Array.isArray(routePlan.path)) return true;
  return routePlan.path.every((position) => isWalkable(routePlan.state, position));
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

  mustReplan(events = []) {
    if (!this.currentRoutePlan || !this.currentExecutablePlan) return true;
    if (this.actionIndex >= this.currentExecutablePlan.length) return true;
    if (events.some((event) => REPLAN_EVENTS.has(eventType(event)))) return true;

    const periodic = Number(this.currentRoutePlan.config?.periodicReplanTicks ?? this.config.planner.periodicReplanTicks);
    if (periodic > 0 && this.beliefs.time - this.lastPlanTime >= periodic) return true;

    return false;
  }

  makePlan(events = []) {
    const start = Date.now();
    const plannerState = buildPlannerState(this.beliefs, this.config);
    const routePlan = replan(plannerState);
    const executablePlan = routePathIsWalkable(routePlan) ? buildExecutablePlan(routePlan) : [];
    const elapsed = Date.now() - start;

    if (executablePlan.length === 0 && routePlan.sequence.length > 1) {
      this.logger.warn("planner produced a non-executable path", { sequence: routePlan.sequence });
    }

    this.currentRoutePlan = routePlan;
    this.currentExecutablePlan = executablePlan;
    this.actionIndex = 0;
    this.lastPlanTime = this.beliefs.time;
    this.beliefs.clearDirty();

    const reason = events.map(eventType).filter(Boolean).join(",") || "missing_or_periodic_plan";
    const candidates = routePlan.candidateGreens.map((green) => green.id).join(",");
    this.logger.info("replan", {
      reason,
      sequence: routePlan.sequence.join(" -> "),
      value: routePlan.value,
      actions: executablePlan.length,
      candidates,
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
      this.beliefs.advanceTime();
      const events = this.beliefs.consumeEvents();
      if (!this.beliefs.ready) return;

      if (this.mustReplan(events)) {
        this.makePlan(events);
      }

      const action = this.currentExecutablePlan?.[this.actionIndex];
      if (!action) {
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
