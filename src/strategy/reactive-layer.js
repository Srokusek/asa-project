import { buildMapProfile, getCell, isMoveAllowed, isWalkable, shortestGridPath } from "../planner/route-planner.js";
import { buildPlannerState } from "../state/planner-state.js";
import { directionFromPositions, manhattan, positionKey, roundTilePosition } from "../utils/geometry.js";
import { evaluateDelivery } from "../missions/reward-model.js";

const PREEMPTABLE_MODES = new Set(["SCOUT_UNIFIED", "LOCAL_EXPLORE", "IDLE"]);

function actionMovesForPath(path) {
  const actions = [];
  for (let i = 0; i < path.length - 1; i += 1) {
    const from = roundTilePosition(path[i]);
    const to = roundTilePosition(path[i + 1]);
    const direction = directionFromPositions(from, to);
    if (direction) actions.push({ type: "move", direction, from, to, reason: "reactive_immediate_pickup" });
  }
  return actions;
}

function enemyOccupies(beliefs, position) {
  for (const enemy of beliefs?.agents?.values?.() ?? []) {
    if (Number(enemy.confidence ?? 0) < 0.5) continue;
    if (positionKey(enemy) === positionKey(position)) return true;
  }
  return false;
}

function visibleParcelAt(beliefs, position) {
  const key = positionKey(position);
  for (const parcel of beliefs?.parcels?.values?.() ?? []) {
    if (parcel.carriedBy) continue;
    if (positionKey(parcel) !== key) continue;
    const visible = Number(parcel.confidence ?? 0) >= 1 || Number(parcel.lastSeenTime ?? -Infinity) >= Number(beliefs.time ?? 0);
    if (visible) return parcel;
  }
  return null;
}

function currentActionIsValid(plannerState, beliefs, action) {
  if (!action) return false;
  if (action.type !== "move") return true;
  if (!action.from || !action.to) return false;
  if (enemyOccupies(beliefs, action.to)) return false;
  return isMoveAllowed(plannerState, action.from, action.to);
}

function nearestDeliveryEvaluation(plannerState, green, pickupTime, config) {
  const profile = plannerState.__mapProfile ?? buildMapProfile(plannerState);
  let best = null;
  for (const red of plannerState.reds ?? []) {
    const path = shortestGridPath(plannerState, green.position, red.position, profile);
    if (!Number.isFinite(path.cost)) continue;
    const valueAtPickup = Number(green.package?.value ?? green.package?.reward ?? config.meanPackageValue ?? 0);
    const pkg = {
      valueAtPickup,
      pickupTime,
      decayRate: Number(green.package?.decayRate ?? config.decayRate ?? 0)
    };
    const evaluation = evaluateDelivery({
      state: plannerState,
      packages: [pkg],
      deliveryTime: pickupTime + path.cost,
      deliveryPosition: red.position,
      config
    });
    if (!evaluation.allowed || evaluation.value <= 0) continue;
    const score = evaluation.value - Number(config.moveWeight ?? 0) * path.cost;
    if (!best || score > best.score) best = { red, path, evaluation, score };
  }
  return best;
}

export function buildImmediatePickupPlan(plannerState, config = {}) {
  if (!plannerState?.me?.position) return null;
  const maxDistance = Math.max(0, Number(config.immediatePickupMaxDistance ?? 4));
  const start = roundTilePosition(plannerState.me.position);
  const profile = plannerState.__mapProfile ?? buildMapProfile(plannerState);
  let best = null;

  for (const green of plannerState.greens ?? []) {
    if (!green.package || green.package.carriedBy) continue;
    if (Number(green.package.confidence ?? 0) < 1) continue;
    if (manhattan(start, green.position) > maxDistance) continue;
    if (!isWalkable(plannerState, green.position)) continue;
    const pickupPath = shortestGridPath(plannerState, start, green.position, profile);
    if (!Number.isFinite(pickupPath.cost) || pickupPath.cost > maxDistance) continue;
    const pickupTime = Number(plannerState.time ?? 0) + pickupPath.cost;
    const delivery = nearestDeliveryEvaluation(plannerState, green, pickupTime, config);
    if (!delivery) continue;
    const score = delivery.score - Number(config.moveWeight ?? 0) * pickupPath.cost;
    if (!best || score > best.score) {
      best = { green, pickupPath, delivery, score };
    }
  }

  if (!best) return null;
  const executablePlan = [
    ...actionMovesForPath(best.pickupPath.path),
    {
      type: "pick_up",
      at: roundTilePosition(best.green.position),
      targetId: best.green.id,
      reason: "reactive_immediate_pickup"
    }
  ];

  return {
    routePlan: {
      mode: "PICKUP_DELIVERY_UNIFIED",
      sequence: ["START", best.green.id],
      path: best.pickupPath.path,
      value: best.score,
      state: plannerState,
      config,
      candidateGreens: [best.green],
      reactive: true,
      reason: "immediate_pickup"
    },
    executablePlan
  };
}

export function tryImmediateAction({ beliefs, currentRoutePlan, currentExecutablePlan, actionIndex = 0, config } = {}) {
  if (!beliefs?.ready || !beliefs?.me) return null;
  const plannerState = buildPlannerState(beliefs, config);
  const position = roundTilePosition(beliefs.me);
  const cell = getCell(plannerState, position);
  const carried = [...(beliefs.carriedParcels?.values?.() ?? [])];

  if (cell?.type === "red" && carried.length > 0) {
    const evaluation = evaluateDelivery({
      state: plannerState,
      packages: plannerState.carriedPackages ?? [],
      deliveryTime: plannerState.time,
      deliveryPosition: position,
      config: config?.planner ?? config ?? {}
    });
    if (evaluation.allowed) {
      return {
        action: {
          type: "put_down",
          at: position,
          parcels: "all",
          reason: "reactive_red_put_down"
        },
        immediate: true,
        evaluation
      };
    }
  }

  const nextAction = currentExecutablePlan?.[actionIndex] ?? null;
  if (currentRoutePlan?.mode === "MANUAL_GOTO") {
    if (currentActionIsValid(plannerState, beliefs, nextAction)) {
      return { action: nextAction, fromCurrentPlan: true };
    }
    return null;
  }

  const localParcel = visibleParcelAt(beliefs, position);
  if (localParcel) {
    return {
      action: {
        type: "pick_up",
        at: position,
        targetId: localParcel.id,
        reason: "reactive_local_pickup"
      },
      immediate: true
    };
  }

  if (currentActionIsValid(plannerState, beliefs, nextAction)) {
    return { action: nextAction, fromCurrentPlan: true };
  }

  if (currentRoutePlan && !PREEMPTABLE_MODES.has(currentRoutePlan.mode)) return null;

  const immediatePickup = buildImmediatePickupPlan(plannerState, config?.planner ?? config ?? {});
  if (immediatePickup) return immediatePickup;
  return null;
}
