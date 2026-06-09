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
  shortestGridPath
} from "./path/pathfinder.js";
import { buildDistanceOracle, getOracleEdge, reconstructGridPath } from "./path/distance-oracle.js";
import { getRedDistanceCacheForState } from "./path/red-distance-cache.js";
import {
  buildNearestRedDistanceMap,
  computeGreenScore,
  computeGreenScores,
  currentGreenValue,
  deliveryBonusAt,
  deliveryCountBonusAt,
  deliveryCountMultiplierAt,
  deliveryMultiplierAt,
  nearestRedDistance,
  packageConfidence,
  packageDecayRate,
  packageReward,
  selectCandidateGreens,
  sigmoid
} from "./scoring/green-scorer.js";
import { estimateDeliveredValueForSinglePackage } from "./scoring/reward-overlays.js";
import {
  bestCompletionValue,
  beatsEnemiesToGreen,
  carriedPotential,
  computeDeliveredValue,
  estimateNearbyPackageBonus,
  extendToGreen,
  finalObjective,
  findBestSequenceUnderBudget,
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
  buildLocalExplorePlan
} from "./scout/scout-planner.js";

const EPSILON = 1e-9;
const UNIFIED_SCOUT_CHECKPOINT_CACHE = new Map();

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

export { buildMapProfile };

export { sigmoid, currentGreenValue, computeGreenScore, computeGreenScores, selectCandidateGreens };

export function buildPointsOfInterest(state, candidateGreens) {
  const carriedPickupAnchors = Array.from(
    new Map(
      (state.carriedPackages ?? [])
        .filter((pkg) => pkg?.pickupSourceId && Number.isFinite(pkg?.pickupPosition?.x) && Number.isFinite(pkg?.pickupPosition?.y))
        .map((pkg) => [
          String(pkg.pickupSourceId),
          {
            id: String(pkg.pickupSourceId),
            type: "anchor",
            position: copyPosition(pkg.pickupPosition)
          }
        ])
    ).values()
  );

  return [
    { id: "START", type: "start", position: copyPosition(state.me.position) },
    ...candidateGreens.map((green) => ({ ...green, type: "green", position: copyPosition(green.position) })),
    ...carriedPickupAnchors,
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
  carriedPotential,
  computeDeliveredValue,
  estimateNearbyPackageBonus,
  extendToGreen,
  finalObjective,
  findBestSequenceUnderBudget,
  initialPlan,
  packageValueAtPickup,
  partialPlanPriority,
  planValue
};

export { reconstructGridPath };

const TARGET_PLAN_MODES = new Set([
  "PICKUP_DELIVERY_UNIFIED"
]);

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

function candidateRejectionReason(diagnostic) {
  if (!diagnostic.reachableFromMe) return "unreachable_from_me";
  if (diagnostic.reward <= 0 || diagnostic.valueAtPickup <= EPSILON) return "zero_reward";
  if (diagnostic.enemyBeatsUs) return "enemy_wins_race";
  if (!diagnostic.reachableRedAfterPickup) return "no_reachable_red_after_pickup";
  return "low_score";
}

function bestSinglePackageDeliveryOverrides(state) {
  if (!Array.isArray(state.reds) || state.reds.length === 0) {
    return {
      deliveryMultiplier: 1,
      deliveryBonus: 0,
      countMultiplier: deliveryCountMultiplierAt(state, 1),
      countBonus: deliveryCountBonusAt(state, 1)
    };
  }

  let bestMultiplier = 1;
  let bestBonus = Number.NEGATIVE_INFINITY;
  for (const red of state.reds) {
    bestMultiplier = Math.max(bestMultiplier, deliveryMultiplierAt(state, red.position));
    bestBonus = Math.max(bestBonus, deliveryBonusAt(state, red.position));
  }

  return {
    deliveryMultiplier: bestMultiplier,
    deliveryBonus: Number.isFinite(bestBonus) ? bestBonus : 0,
    countMultiplier: deliveryCountMultiplierAt(state, 1),
    countBonus: deliveryCountBonusAt(state, 1)
  };
}

function diagnoseCandidateGreens(state, candidateGreens, oracle, config) {
  return candidateGreens.map((green) => {
    const startEdge = getOracleEdge(oracle, "START", green.id);
    const pickupDistance = startEdge?.cost ?? distanceFromMe(state, green.position);
    const reachableFromMe = Number.isFinite(pickupDistance);
    const pickupTime = reachableFromMe ? asNumber(state.time, 0) + pickupDistance : Infinity;
    const valueAtPickup = reachableFromMe ? packageValueAtPickup(state, green, pickupTime, config) : 0;
    let bestGreenToRed = Infinity;
    let bestEstimatedDeliveredValue = null;
    const decayRate = packageDecayRate(green, config.decayRate);

    for (const red of oracle.points.filter((point) => point.type === "red")) {
      const edge = getOracleEdge(oracle, green.id, red.id);
      if (!edge || !Number.isFinite(edge.cost)) continue;
      bestGreenToRed = Math.min(bestGreenToRed, edge.cost);
      const estimatedValueAtDelivery = Math.max(0, valueAtPickup - decayRate * edge.cost);
      const estimatedDeliveredValue = estimateDeliveredValueForSinglePackage({
        deliveredBaseValue: estimatedValueAtDelivery,
        state,
        deliveryPosition: red.position,
        count: 1
      });
      bestEstimatedDeliveredValue = bestEstimatedDeliveredValue === null
        ? estimatedDeliveredValue
        : Math.max(bestEstimatedDeliveredValue, estimatedDeliveredValue);
    }

    if (!Number.isFinite(bestGreenToRed)) bestGreenToRed = nearestRedDistance(state, green.position);
    const deliveryDistance = bestGreenToRed;
    const reachableRedAfterPickup = Number.isFinite(deliveryDistance);
    const estimatedDeliveredValue = reachableFromMe && reachableRedAfterPickup
      ? (
        bestEstimatedDeliveredValue !== null
          ? bestEstimatedDeliveredValue
          : estimateDeliveredValueForSinglePackage({
            deliveredBaseValue: Math.max(0, valueAtPickup - decayRate * deliveryDistance),
            state,
            deliveryPosition: green.position,
            count: 1,
            deliveryOverrides: bestSinglePackageDeliveryOverrides(state)
          })
      )
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

function buildUnifiedPickupDeliveryPlan(state, profile, config, greenScores, candidateGreens) {
  const points = buildPointsOfInterest(state, candidateGreens);
  const oracle = buildDistanceOracle(state, points);
  const result = findBestSequenceUnderBudget(state, points, oracle, greenScores, config);
  const bestPlan = result.plan;
  const path = reconstructGridPath(bestPlan.sequence, oracle);
  const routePlan = baseRoutePlan({
    mode: "PICKUP_DELIVERY_UNIFIED",
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
    invalidPlanDetected: Boolean(bestPlan.failed),
    fallbackStage: "unified_full_plan"
  });

  if (routePlan?.oracle?.stats && state.__redDistanceCacheStats) {
    routePlan.oracle.stats.redDistanceCacheHit = state.__redDistanceCacheStats.hits;
    routePlan.oracle.stats.redDistanceCacheMiss = state.__redDistanceCacheStats.misses;
    routePlan.oracle.stats.redDistanceCacheBuildMs = state.__redDistanceCacheStats.buildMs;
    routePlan.oracle.stats.redDistanceCacheTopologyHit = Number(Boolean(state.__redDistanceCacheStats.cacheHit));
  }

  return {
    ...routePlan,
    unifiedOutcome: result.outcome,
    unifiedTimeoutHit: Boolean(result.timeoutHit),
    unifiedElapsedMs: result.elapsedMs,
    redShortlistStats: result.stats ?? null
  };
}

export function replan(state) {
  const planningState = state?.__plannerStateNormalized ? state : parseMap(state);
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
  const redDistanceCacheStatus = getRedDistanceCacheForState(planningState);
  Object.defineProperty(planningState, "__redDistanceCache", {
    value: redDistanceCacheStatus.index,
    enumerable: false
  });
  Object.defineProperty(planningState, "__redDistanceCacheStats", {
    value: {
      topologyKey: redDistanceCacheStatus.topologyKey,
      cacheHit: redDistanceCacheStatus.cacheHit,
      buildMs: redDistanceCacheStatus.buildMs,
      hits: 0,
      misses: 0
    },
    enumerable: false
  });
  const config = choosePlannerConfig(profile, {
    ...planningState.params,
    sensingRange: planningState.sensingRange
  });
  const greenScores = computeGreenScores(planningState, config);
  // candidate greens only include possible packages
  const candidateGreens = selectCandidateGreens(planningState, greenScores, config);
  const selectionDiagnostics = planningState.__candidateSelectionDiagnostics ?? [];
  let invalidPlanDetected = false;
  let candidateDiagnostics = selectionDiagnostics;

  if ((planningState.carriedPackages ?? []).length > 0 || candidateGreens.length > 0) {
    const unifiedPlan = buildUnifiedPickupDeliveryPlan(
      planningState,
      profile,
      config,
      greenScores,
      candidateGreens
    );

    if (!unifiedPlan.plan.failed && !isInvalidNonIdleRoutePlan(unifiedPlan)) {
      return {
        ...unifiedPlan,
        candidateDiagnostics
      };
    }

    invalidPlanDetected = true;
    candidateDiagnostics = [
      ...selectionDiagnostics,
      ...diagnoseCandidateGreens(planningState, candidateGreens, unifiedPlan.oracle, config)
    ];
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
