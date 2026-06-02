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

function parcelIsCurrentlyAvailable(beliefs, parcel, position = null) {
  if (!parcel) return false;
  if (parcel.carriedBy) return false;
  if (position && positionKey(parcel) !== positionKey(position)) return false;
  const visible = Number(parcel.confidence ?? 0) >= 1 || Number(parcel.lastSeenTime ?? -Infinity) >= Number(beliefs?.time ?? 0);
  if (!visible) return false;
  return Number(beliefs?.estimateParcelReward?.(parcel) ?? parcel.reward ?? 0) > 0;
}

function parcelAllowedByMissionFilters(plannerState, parcel, beliefs) {
  const filters = plannerState?.deliveryRules?.parcelValueFilters ?? plannerState?.parcelValueFilters ?? [];
  if (!Array.isArray(filters) || filters.length === 0) return true;

  const value = Number(beliefs?.estimateParcelReward?.(parcel) ?? parcel?.reward ?? 0);
  for (const filter of filters) {
    const minValue = Number.isFinite(Number(filter.minValue)) ? Number(filter.minValue) : null;
    const maxValue = Number.isFinite(Number(filter.maxValue)) ? Number(filter.maxValue) : null;
    const violates = (minValue !== null && value < minValue) || (maxValue !== null && value > maxValue);
    if (violates && filter.hard !== false) return false;
  }
  return true;
}

function visibleParcelAt(beliefs, position, plannerState = null) {
  const key = positionKey(position);
  for (const parcel of beliefs?.parcels?.values?.() ?? []) {
    if (positionKey(parcel) !== key) continue;
    if (!parcelIsCurrentlyAvailable(beliefs, parcel, position)) continue;
    if (!parcelAllowedByMissionFilters(plannerState, parcel, beliefs)) continue;
    return parcel;
  }
  return null;
}

function validateMoveAction(plannerState, beliefs, action) {
  if (!action.from || !action.to) return { ok: false, reason: "move_missing_endpoint" };
  const actualPosition = roundTilePosition(beliefs.me);
  if (positionKey(actualPosition) !== positionKey(action.from)) return { ok: false, reason: "move_from_stale" };
  if (!isMoveAllowed(plannerState, action.from, action.to)) return { ok: false, reason: "move_not_allowed" };
  if (enemyOccupies(beliefs, action.to)) return { ok: false, reason: "enemy_in_next_cell" };
  return { ok: true, reason: "move_allowed" };
}

function validatePickupAction(plannerState, beliefs, action, config) {
  const currentPosition = roundTilePosition(beliefs.me);
  const actionPosition = action.at ? roundTilePosition(action.at) : currentPosition;
  if (positionKey(currentPosition) !== positionKey(actionPosition)) {
    return { ok: false, reason: "pickup_not_on_target_tile" };
  }

  const parcel = visibleParcelAt(beliefs, currentPosition, plannerState);
  if (!parcel) return { ok: false, reason: "pickup_parcel_unavailable" };
  if (String(action.targetId ?? "").startsWith("P_")) {
    const expectedId = String(action.targetId).slice(2);
    if (String(parcel.id) !== expectedId) return { ok: false, reason: "pickup_target_mismatch" };
  }
  if (!parcelAllowedByMissionFilters(plannerState, parcel, beliefs)) {
    return { ok: false, reason: "pickup_forbidden_by_mission_filter" };
  }
  if (Number(parcel.confidence ?? 0) < Number(config?.planner?.minParcelConfidence ?? config?.minParcelConfidence ?? 0.3)) {
    return { ok: false, reason: "pickup_low_confidence" };
  }
  return { ok: true, reason: "pickup_allowed", parcel };
}

function validatePutDownAction(plannerState, beliefs, action, config) {
  const currentPosition = roundTilePosition(beliefs.me);
  const actionPosition = action.at ? roundTilePosition(action.at) : currentPosition;
  if (positionKey(currentPosition) !== positionKey(actionPosition)) {
    return { ok: false, reason: "put_down_not_on_target_tile" };
  }
  const cell = getCell(plannerState, currentPosition);
  if (cell?.type !== "red") return { ok: false, reason: "put_down_not_on_red" };
  if ((plannerState.carriedPackages ?? []).length === 0) return { ok: false, reason: "put_down_empty_carried" };

  const evaluation = evaluateDelivery({
    state: plannerState,
    packages: plannerState.carriedPackages ?? [],
    deliveryTime: plannerState.time,
    deliveryPosition: currentPosition,
    config: config?.planner ?? config ?? {}
  });
  if (!evaluation.allowed) return { ok: false, reason: "put_down_delivery_forbidden", evaluation };
  return { ok: true, reason: "put_down_allowed", evaluation };
}

function currentActionIsValid(plannerState, beliefs, action, config = {}) {
  if (!action) return { ok: false, reason: "missing_action" };
  if (action.type === "move") return validateMoveAction(plannerState, beliefs, action);
  if (action.type === "pick_up") return validatePickupAction(plannerState, beliefs, action, config);
  if (action.type === "put_down") return validatePutDownAction(plannerState, beliefs, action, config);
  if (action.type === "write_message" || action.type === "say" || action.type === "shout") {
    return { ok: true, reason: "message_action_allowed" };
  }
  return { ok: false, reason: "unknown_action_type" };
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

export function tryImmediateAction({
  beliefs,
  currentRoutePlan,
  currentExecutablePlan,
  actionIndex = 0,
  config,
  coordinationController = null
} = {}) {
  if (!beliefs?.ready || !beliefs?.me) return null;
  const plannerState = buildPlannerState(beliefs, config);
  const position = roundTilePosition(beliefs.me);
  const cell = getCell(plannerState, position);
  const carried = [...(beliefs.carriedParcels?.values?.() ?? [])];

  if (cell?.type === "red" && carried.length > 0) {
    const putDown = validatePutDownAction(plannerState, beliefs, { type: "put_down", at: position }, config);
    if (putDown.ok) {
      return {
        action: {
          type: "put_down",
          at: position,
          parcels: "all",
          reason: "reactive_red_put_down"
        },
        immediate: true,
        evaluation: putDown.evaluation
      };
    }
  }

  const nextAction = currentExecutablePlan?.[actionIndex] ?? null;
  if (coordinationController?.movementBlocked?.(nextAction)) return null;
  if (currentRoutePlan && nextAction) {
    const validation = currentActionIsValid(plannerState, beliefs, nextAction, config);
    if (!validation.ok) {
      return {
        invalidCurrentPlan: true,
        reason: validation.reason,
        action: nextAction
      };
    }
  }
  if (currentRoutePlan?.mode === "MANUAL_GOTO") {
    if (nextAction) {
      return { action: nextAction, fromCurrentPlan: true };
    }
    return null;
  }

  const localParcel = visibleParcelAt(beliefs, position, plannerState);
  if (localParcel && !coordinationController?.movementBlocked?.({ type: "pick_up" })) {
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

  if (currentRoutePlan && nextAction) {
    return { action: nextAction, fromCurrentPlan: true };
  }

  if (currentRoutePlan && !PREEMPTABLE_MODES.has(currentRoutePlan.mode)) return null;

  const immediatePickup = buildImmediatePickupPlan(plannerState, config?.planner ?? config ?? {});
  if (immediatePickup?.executablePlan?.[0] && coordinationController?.movementBlocked?.(immediatePickup.executablePlan[0])) {
    return null;
  }
  if (immediatePickup) return immediatePickup;
  return null;
}
