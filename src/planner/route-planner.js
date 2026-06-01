/**
 * Grid route planner for parcel pickup/deliveroo games.
 *
 * The planner searches only on a reduced graph of important points:
 * START + selected green cells + red delivery cells. Real grid paths are
 * computed between those points and cached in a distance oracle.
 */

import { directionFromPositions, manhattan } from "../utils/geometry.js";
import { choosePlannerConfig } from "../config.js";
import {
  asNumber,
  clamp,
  positionKey,
  copyPosition,
  parseMap,
  inBounds,
  getCell,
  isWalkable,
  isMoveAllowed,
  buildMapProfile
} from "./path/grid-utils.js";
import {
  aStarGridPath,
  bfsAllDistancesFrom,
  bfsGridPath,
  buildDirectedDistanceFields,
  distanceFromMe,
  getDirectedNeighbors,
  manhattanGridPath,
  PriorityQueue,
  reachableRedFromPosition,
  shortestGridPath
} from "./path/pathfinder.js";
import { buildDistanceOracle, getOracleEdge, reconstructGridPath } from "./path/distance-oracle.js";
import {
  buildNearestRedDistanceMap,
  computeGreenScore,
  computeGreenScores,
  currentGreenValue,
  hasAvailablePackage,
  nearestRedDistance,
  packageConfidence,
  packageDecayRate,
  packageReward,
  selectCandidateGreens,
  sigmoid,
  winProbability
} from "./scoring/green-scorer.js";
import {
  bestCompletionValue,
  betterPlan,
  beatsEnemiesToGreen,
  carriedPotential,
  computeDeliveredValue,
  estimateNearbyPackageBonus,
  extendToGreen,
  extendToRed,
  finalObjective,
  findBestSequence,
  initialPlan,
  packageValueAtPickup,
  partialPlanPriority,
  planValue
} from "./search/plan-search.js";
import { baseRoutePlan } from "./route-plan.js";
import {
  buildScoutCheckpointIndex,
  buildScoutCheckpointSignature,
  buildUnifiedScoutPlan,
  buildLocalExplorePlan,
  visibleAvailablePackages
} from "./scout/scout-planner.js";

const EPSILON = 1e-9;
const UNIFIED_SCOUT_CHECKPOINT_CACHE = new Map();

function pairKey(fromId, toId) {
  return `${fromId}->${toId}`;
}

function scoutCheckpointIndexFor(state, config, profile) {
  const signature = buildScoutCheckpointSignature(state, config, profile);
  const cached = UNIFIED_SCOUT_CHECKPOINT_CACHE.get(signature);
  if (cached) {
    return { ...cached, cacheHit: true };
  }

  const built = buildScoutCheckpointIndex(state, config, profile, signature);
  UNIFIED_SCOUT_CHECKPOINT_CACHE.set(signature, built);
  if (UNIFIED_SCOUT_CHECKPOINT_CACHE.size > 16) {
    const oldest = UNIFIED_SCOUT_CHECKPOINT_CACHE.keys().next().value;
    UNIFIED_SCOUT_CHECKPOINT_CACHE.delete(oldest);
  }

  return { ...built, cacheHit: false };
}

export { parseMap, inBounds, getCell, isWalkable, isMoveAllowed };

function estimateDistance(_state, from, to) {
  return manhattan(from, to);
}

function rankingDistance(state, from, to) {
  const key = `${positionKey(from)}->${positionKey(to)}`;
  const cache = state.__rankingDistanceCache;
  if (cache?.has(key)) return cache.get(key);

  if (positionKey(from) === positionKey(state.me.position)) {
    const directed = distanceFromMe(state, to);
    if (Number.isFinite(directed)) {
      cache?.set(key, directed);
      return directed;
    }
  }

  const profile = state.__mapProfile ?? buildMapProfile(state);
  let cost = manhattan(from, to);
  if (!profile.hasObstacles && !profile.hasDirectionalTiles && profile.hasUniformCosts) {
    cache?.set(key, cost);
    return cost;
  }
  cost = shortestGridPath(state, from, to, profile).cost;
  cache?.set(key, cost);
  return cost;
}

export { buildMapProfile };

export { sigmoid, winProbability, currentGreenValue, computeGreenScore, computeGreenScores, selectCandidateGreens };

export function buildPointsOfInterest(state, candidateGreens) {
  return [
    { id: "START", type: "start", position: copyPosition(state.me.position) },
    ...candidateGreens.map((green) => ({ ...green, type: "green", position: copyPosition(green.position) })),
    ...state.reds.map((red) => ({ ...red, type: "red", position: copyPosition(red.position) }))
  ];
}

export {
  aStarGridPath,
  bfsAllDistancesFrom,
  bfsGridPath,
  buildDirectedDistanceFields,
  getDirectedNeighbors,
  manhattanGridPath,
  PriorityQueue,
  shortestGridPath
};

export { buildDistanceOracle, getOracleEdge };

export {
  bestCompletionValue,
  betterPlan,
  carriedPotential,
  computeDeliveredValue,
  estimateNearbyPackageBonus,
  extendToGreen,
  extendToRed,
  finalObjective,
  findBestSequence,
  initialPlan,
  packageValueAtPickup,
  partialPlanPriority,
  planValue
};

export { reconstructGridPath };

const TARGET_PLAN_MODES = new Set(["PICKUP_DELIVERY", "DELIVERY_ONLY", "PICKUP_ONLY", "OPPORTUNISTIC_PICKUP"]);

function routePlanWouldHaveExecutableActions(routePlan) {
  if (!routePlan?.oracle || !Array.isArray(routePlan.sequence)) return false;

  for (let i = 0; i < routePlan.sequence.length - 1; i += 1) {
    const fromId = routePlan.sequence[i];
    const toId = routePlan.sequence[i + 1];
    const edge = getOracleEdge(routePlan.oracle, fromId, toId, { requirePath: true });
    const toPoint = routePlan.oracle.pointsById?.get(toId) ?? routePlan.oracle.points?.find((point) => point.id === toId);
    if (!edge || !toPoint) continue;
    if (Array.isArray(edge.path) && edge.path.length > 1) return true;
    if (toPoint.type === "green" && toPoint.package && !toPoint.noPickup) return true;
    if (toPoint.type === "red") return true;
  }

  return false;
}

function isInvalidNonIdleRoutePlan(routePlan) {
  if (!routePlan || !TARGET_PLAN_MODES.has(routePlan.mode)) return false;
  if (!Array.isArray(routePlan.sequence) || routePlan.sequence.length <= 1) return true;
  if (routePlan.sequence.length === 1 && routePlan.sequence[0] === "START") return true;
  if (!Array.isArray(routePlan.path) || routePlan.path.length === 0) return true;
  return !routePlanWouldHaveExecutableActions(routePlan);
}

function buildIdlePlan(state, profile, config, greenScores) {
  const startPoint = { id: "START", type: "start", position: copyPosition(state.me.position) };
  const oracle = {
    entries: new Map(),
    points: [startPoint],
    pointsById: new Map([["START", startPoint]]),
    profile
  };

  return baseRoutePlan({
    mode: "IDLE",
    sequence: ["START"],
    path: [copyPosition(state.me.position)],
    value: 0,
    plan: initialPlan(state),
    profile,
    config,
    greenScores,
    oracle,
    state
  });
}

function buildDeliveryOnlyPlan(state, profile, config, greenScores) {
  if (!state.reds || state.reds.length === 0 || (state.carriedPackages ?? []).length === 0) return null;

  const points = buildPointsOfInterest(state, []);
  const oracle = buildDistanceOracle(state, points);
  // init startPlan which only contains the start
  const startPlan = initialPlan(state);
  let bestPlan = null;

  for (const red of points.filter((point) => point.type === "red")) {
    const deliveredPlan = extendToRed(startPlan, red, state, oracle, config);
    if (deliveredPlan) {
      bestPlan = betterPlan(bestPlan, deliveredPlan, state, oracle, config);
    }
  }

  if (!bestPlan) return null;
  const path = reconstructGridPath(bestPlan.sequence, oracle);
  const routePlan = baseRoutePlan({
    mode: "DELIVERY_ONLY",
    sequence: bestPlan.sequence,
    path,
    value: planValue(bestPlan, state, oracle, config),
    plan: bestPlan,
    profile,
    config,
    greenScores,
    oracle,
    state,
    fallbackStage: "full_plan"
  });
  if (isInvalidNonIdleRoutePlan(routePlan)) return null;

  return routePlan;
}

function candidateRejectionReason(diagnostic) {
  if (!diagnostic.reachableFromMe) return "unreachable_from_me";
  if (diagnostic.reward <= 0 || diagnostic.valueAtPickup <= EPSILON) return "zero_reward";
  if (diagnostic.enemyBeatsUs) return "enemy_wins_race";
  if (!diagnostic.reachableRedAfterPickup) return "no_reachable_red_after_pickup";
  return "low_score";
}

function diagnoseCandidateGreens(state, candidateGreens, oracle, config) {
  return candidateGreens.map((green) => {
    const startEdge = getOracleEdge(oracle, "START", green.id);
    const pickupDistance = startEdge?.cost ?? distanceFromMe(state, green.position);
    const reachableFromMe = Number.isFinite(pickupDistance);
    const pickupTime = reachableFromMe ? asNumber(state.time, 0) + pickupDistance : Infinity;
    const valueAtPickup = reachableFromMe ? packageValueAtPickup(state, green, pickupTime, config) : 0;
    let bestGreenToRed = Infinity;

    for (const red of oracle.points.filter((point) => point.type === "red")) {
      const edge = getOracleEdge(oracle, green.id, red.id);
      if (edge && Number.isFinite(edge.cost)) bestGreenToRed = Math.min(bestGreenToRed, edge.cost);
    }

    if (!Number.isFinite(bestGreenToRed)) bestGreenToRed = nearestRedDistance(state, green.position);
    const deliveryDistance = bestGreenToRed;
    const reachableRedAfterPickup = Number.isFinite(deliveryDistance);
    const decayRate = packageDecayRate(green, config.decayRate);
    const estimatedDeliveredValue = reachableFromMe && reachableRedAfterPickup
      ? packageReward(green, config.meanPackageValue) - decayRate * (pickupDistance + deliveryDistance)
      : 0;
    const estimatedValueAtDelivery = reachableRedAfterPickup
      ? Math.max(0, valueAtPickup - decayRate * deliveryDistance)
      : 0;
    const enemyBeatsUs = reachableFromMe && !beatsEnemiesToGreen(state, green, pickupDistance, config);
    const diagnostic = {
      id: green.id,
      position: copyPosition(green.position),
      reward: packageReward(green, config.meanPackageValue),
      confidence: packageConfidence(green),
      pickupDistance,
      deliveryDistance,
      estimatedDeliveredValue,
      reachableFromMe,
      reachableRedAfterPickup,
      distanceStartToGreen: pickupDistance,
      startToGreenFinite: reachableFromMe,
      nearestRedDistance: deliveryDistance,
      greenToRedFinite: reachableRedAfterPickup,
      enemyBeatsUs,
      valueAtPickup,
      estimatedValueAtDelivery,
      rejectionReason: "unknown"
    };
    diagnostic.rejectionReason = candidateRejectionReason(diagnostic);
    return diagnostic;
  });
}

export function buildPickupOnlyPlan(state, candidateGreens, oracle, config, profile, greenScores) {
  let best = null;

  for (const green of candidateGreens) {
    if (!hasAvailablePackage(green, config)) continue;

    const edge = getOracleEdge(oracle, "START", green.id);
    if (!edge || !Number.isFinite(edge.cost)) continue;

    const pickupTime = asNumber(state.time, 0) + edge.cost;
    const valueAtPickup = packageValueAtPickup(state, green, pickupTime, config);
    if (valueAtPickup <= EPSILON) continue;

    const win = winProbability(state, green, edge.cost, config);
    const value = valueAtPickup * win - config.moveWeight * edge.cost;
    const pickupPlan = {
      ...initialPlan(state),
      sequence: ["START", green.id],
      currentId: green.id,
      currentPosition: copyPosition(green.position),
      time: pickupTime,
      moveCost: edge.cost,
      pickedPackages: [
        {
          greenId: green.id,
          packageId: String(green.package.id),
          valueAtPickup,
          pickupTime,
          decayRate: packageDecayRate(green, config.decayRate),
          confidence: packageConfidence(green)
        }
      ],
      pickedGreenIds: new Set([green.id]),
      deliveredScore: 0,
      value,
      incomplete: true,
      needsDeliveryAfterPickup: true
    };

    if (!best || value > best.value + EPSILON || (Math.abs(value - best.value) <= EPSILON && edge.cost < best.edgeCost)) {
      best = { green, edgeCost: edge.cost, plan: pickupPlan, value };
    }
  }

  if (!best) return null;
  const bestEdge = getOracleEdge(oracle, "START", best.green.id, { requirePath: true });
  if (!bestEdge || !Array.isArray(bestEdge.path) || bestEdge.path.length === 0) return null;

  const routePlan = baseRoutePlan({
    mode: "PICKUP_ONLY",
    sequence: ["START", best.green.id],
    path: bestEdge.path.map(copyPosition),
    value: best.value,
    plan: best.plan,
    profile,
    config,
    greenScores,
    candidateGreens,
    oracle,
    state,
    fallbackStage: "pickup_only"
  });

  return isInvalidNonIdleRoutePlan(routePlan) ? null : routePlan;
}

function buildPickupDeliveryPlan(state, profile, config, greenScores, candidateGreens) {
  const points = buildPointsOfInterest(state, candidateGreens);
  const oracle = buildDistanceOracle(state, points);
  const bestPlan = findBestSequence(state, points, oracle, greenScores, config);
  const path = reconstructGridPath(bestPlan.sequence, oracle);
  const routePlan = baseRoutePlan({
    mode: "PICKUP_DELIVERY",
    sequence: bestPlan.sequence,
    path,
    value: bestPlan.value,
    plan: bestPlan,
    profile,
    config,
    greenScores,
    candidateGreens,
    oracle,
    state,
    invalidPlanDetected: Boolean(bestPlan.failed || bestPlan.incomplete),
    fallbackStage: "full_plan"
  });

  if (bestPlan.failed || bestPlan.incomplete || isInvalidNonIdleRoutePlan(routePlan)) {
    return {
      ...routePlan,
      invalidPlanDetected: true,
      failureReason: bestPlan.failureReason ?? (bestPlan.incomplete ? "incomplete_sequence" : "invalid_non_idle_plan")
    };
  }

  return routePlan;
}

export function replan(state) {
  const planningState = parseMap(state);
  const profile = buildMapProfile(planningState);
  Object.defineProperty(planningState, "__mapProfile", { value: profile, enumerable: false });
  Object.defineProperty(planningState, "__rankingDistanceCache", { value: new Map(), enumerable: false });
  const directedStart = Date.now();
  const directedDistanceFields = buildDirectedDistanceFields(planningState);
  const startSingleSourceMs = Date.now() - directedStart;
  Object.defineProperty(planningState, "__directedDistanceFields", {
    value: directedDistanceFields,
    enumerable: false
  });
  Object.defineProperty(planningState, "__startSingleSourceMs", {
    value: startSingleSourceMs,
    enumerable: false
  });
  Object.defineProperty(planningState, "__redDistanceMap", {
    value: buildNearestRedDistanceMap(planningState, profile),
    enumerable: false
  });
  const config = choosePlannerConfig(profile);
  const greenScores = computeGreenScores(planningState, config);
  // candidate greens only include possible packages
  const candidateGreens = selectCandidateGreens(planningState, greenScores, config);
  const selectionDiagnostics = planningState.__candidateSelectionDiagnostics ?? [];
  const visiblePackages = visibleAvailablePackages(planningState, config);
  let invalidPlanDetected = false;
  let candidateDiagnostics = selectionDiagnostics;

  // consider only DELIVERY_ONLY plans when we picked up a parcel
  // could add additional control here for other constraints
  // Problem -> if we do not use deliver only plans, the delivery brakes and replans take a long time
  if ((planningState.carriedPackages ?? []).length > 0) {
    const deliveryPlan = buildDeliveryOnlyPlan(planningState, profile, config, greenScores);
    if (deliveryPlan) return deliveryPlan;
  }

  // if we are not carrying any packages and have some candidate packages -> create full plan
  if ((planningState.carriedPackages ?? []).length === 0 && candidateGreens.length > 0) {
    const fullPlan = buildPickupDeliveryPlan(planningState, profile, config, greenScores, candidateGreens);
    if (fullPlan && !fullPlan.invalidPlanDetected && !isInvalidNonIdleRoutePlan(fullPlan)) {
      return {
        ...fullPlan,
        candidateDiagnostics
      };
    }

    // if we couldn't find a full pickup delivery plan, 
    invalidPlanDetected = true;
    candidateDiagnostics = [
      ...selectionDiagnostics,
      ...diagnoseCandidateGreens(planningState, candidateGreens, fullPlan.oracle, config)
    ];
    // try to create a pickupOnlyPlan, only creates one if there are available packages
    const pickupOnlyPlan = buildPickupOnlyPlan(
      planningState,
      candidateGreens,
      fullPlan.oracle,
      config,
      profile,
      greenScores
    );
    if (pickupOnlyPlan) {
      return {
        ...pickupOnlyPlan,
        invalidPlanDetected,
        fallbackStage: "pickup_only",
        candidateDiagnostics
      };
    }
  }

  if ((planningState.carriedPackages ?? []).length === 0 ) {
    const checkpointIndex = scoutCheckpointIndexFor(planningState, config, profile);
    const scoutPlan = buildUnifiedScoutPlan(planningState, profile, config, greenScores, checkpointIndex);
    if (scoutPlan) {
      return {
        ...scoutPlan,
        invalidPlanDetected,
        fallbackStage: "scout",
        candidateDiagnostics,
        scoutCheckpointCacheHit: checkpointIndex.cacheHit
      };
    }
  }

  const localExplorePlan = buildLocalExplorePlan(planningState, profile, config);
  if (localExplorePlan) {
    return {
      ...localExplorePlan,
      invalidPlanDetected,
      fallbackStage: "local_explore",
      candidateDiagnostics
    };
  }

  return {
    ...buildIdlePlan(planningState, profile, config, greenScores),
    invalidPlanDetected,
    fallbackStage: "idle",
    candidateDiagnostics
  };
}

export { directionFromPositions, manhattan };
