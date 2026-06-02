import { manhattan } from "../../utils/geometry.js";
import { DEFAULT_PARAMS } from "../default-params.js";
import { asNumber, clamp, copyPosition, positionKey } from "../path/grid-utils.js";
import {
  distanceFromMe,
  distanceToNearestReachableRed,
  getDirectedNeighbors,
  shortestGridPath
} from "../path/pathfinder.js";
import { buildMapProfile } from "../path/grid-utils.js";
import {
  adjustDeliveredParcelBaseValue,
  adjustPickupBaseValue,
  deliveryBonusAt,
  deliveryCountBonusAt,
  deliveryCountMultiplierAt,
  deliveryMultiplierAt,
  estimateDeliveredValueForSinglePackage,
  pickupMultiplierAt
} from "./reward-overlays.js";

export {
  adjustDeliveredParcelBaseValue,
  deliveryBonusAt,
  deliveryCountBonusAt,
  deliveryCountMultiplierAt,
  deliveryMultiplierAt,
  pickupMultiplierAt
} from "./reward-overlays.js";

const EPSILON = 1e-9;

export function sigmoid(x) {
  if (x >= 40) return 1;
  if (x <= -40) return 0;
  return 1 / (1 + Math.exp(-x));
}

function estimateDistance(_state, from, to) {
  return manhattan(from, to);
}

export function rankingDistance(state, from, to) {
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
  let cost = estimateDistance(state, from, to);
  if (!profile.hasObstacles && !profile.hasDirectionalTiles && profile.hasUniformCosts) {
    cache?.set(key, cost);
    return cost;
  }
  cost = shortestGridPath(state, from, to, profile).cost;
  cache?.set(key, cost);
  return cost;
}

export function winProbability(state, green, etaMe, config) {
  if (!state.enemies || state.enemies.length === 0) return 1;

  let probability = 1;
  if (config.ignoreEnemyEta) { // enable skipping this calculation
    return 1 }
  for (const enemy of state.enemies) {;
    const enemyEta = rankingDistance(state, enemy.position, green.position);
    probability = Math.min(probability, sigmoid(config.kWin * (enemyEta - etaMe)));
  }
  return probability;
}

export function packageConfidence(green) {
  return clamp(asNumber(green.package?.confidence, 1), 0, 1);
}

export function packageReward(green, fallbackValue) {
  return asNumber(green.package?.value ?? green.package?.reward, fallbackValue);
}

export function packageDecayRate(green, fallbackRate) {
  return asNumber(green.package?.decayRate, fallbackRate);
}

function bestDeliveryMultiplier(state) {
  if (!Array.isArray(state.reds) || state.reds.length === 0) return 1;
  let best = 1;
  for (const red of state.reds) {
    best = Math.max(best, deliveryMultiplierAt(state, red.position));
  }
  return best;
}

function bestDeliveryBonus(state) {
  if (!Array.isArray(state.reds) || state.reds.length === 0) return 0;
  let best = Number.NEGATIVE_INFINITY;
  for (const red of state.reds) {
    best = Math.max(best, deliveryBonusAt(state, red.position));
  }
  return Number.isFinite(best) ? best : 0;
}

function bestSinglePackageDeliveryOverrides(state) {
  return {
    deliveryMultiplier: bestDeliveryMultiplier(state),
    deliveryBonus: bestDeliveryBonus(state),
    countMultiplier: deliveryCountMultiplierAt(state, 1),
    countBonus: deliveryCountBonusAt(state, 1)
  };
}

export function hasAvailablePackage(green, config) {
  if (!green.package || green.package.carriedBy) return false;
  if (packageConfidence(green) < config.minParcelConfidence) return false;
  if (packageReward(green, config.meanPackageValue) <= 0) return false;
  return true;
}

export function buildNearestRedDistanceMap(state, profile = null) {
  const mapProfile = profile ?? buildMapProfile(state);
  const distanceByKey = new Map();
  if (!state.reds || state.reds.length === 0 || !mapProfile.hasUniformCosts || mapProfile.hasDirectionalConstraints) {
    return distanceByKey;
  }

  const queue = [];
  let head = 0;
  for (const red of state.reds) {
    if (!Number.isFinite(distanceFromMe(state, red.position))) continue;
    const key = positionKey(red.position);
    if (distanceByKey.has(key)) continue;
    distanceByKey.set(key, 0);
    queue.push(copyPosition(red.position));
  }

  while (head < queue.length) {
    const current = queue[head];
    head += 1;
    const currentDistance = distanceByKey.get(positionKey(current)) ?? 0;
    for (const next of getDirectedNeighbors(state, current)) {
      const key = positionKey(next);
      if (distanceByKey.has(key)) continue;
      distanceByKey.set(key, currentDistance + 1);
      queue.push(next);
    }
  }

  return distanceByKey;
}

export function nearestRedDistance(state, position) {
  if (!state.reds || state.reds.length === 0) return 0;
  if (state.__directedDistanceFields) {
    return distanceToNearestReachableRed(state, position);
  }
  const cached = state.__redDistanceMap?.get(positionKey(position));
  if (Number.isFinite(cached)) return cached;
  return Math.min(...state.reds.map((red) => rankingDistance(state, position, red.position)));
}

export function currentGreenValue(state, green, config) {
  if (!hasAvailablePackage(green, config)) return 0;
  const etaMe = rankingDistance(state, state.me.position, green.position);
  const etaRed = nearestRedDistance(state, green.position);
  if (!Number.isFinite(etaMe) || !Number.isFinite(etaRed)) return 0;
  const etaTotal = etaMe + etaRed;
  const decayRate = packageDecayRate(green, config.decayRate);
  const currentValue = packageReward(green, config.meanPackageValue);
  const deliveryAwareValue = Math.max(0, currentValue - decayRate * etaTotal);
  const pickupAdjustedValue = packageConfidence(green) * adjustPickupBaseValue(deliveryAwareValue, state, green.position);
  const adjustedValue = estimateDeliveredValueForSinglePackage({
    deliveredBaseValue: pickupAdjustedValue,
    state,
    deliveryPosition: green.position,
    count: 1,
    deliveryOverrides: bestSinglePackageDeliveryOverrides(state)
  });
  return winProbability(state, green, etaMe, config) * adjustedValue;
}

export function computeGreenScore(state, green, config) {
  return currentGreenValue(state, green, config);
}

export function computeGreenScores(state, config) {
  const scores = new Map();
  for (const green of state.greens) {
    scores.set(green.id, computeGreenScore(state, green, config));
  }
  return scores;
}

export function selectCandidateGreens(state, greenScores, config) {
  const diagnostics = [];
  const entries = [...state.greens]
    .map((green) => {
      const reward = packageReward(green, config.meanPackageValue);
      const confidence = packageConfidence(green);
      if (!green.package || green.package.carriedBy) return null;
      if (reward <= 0) {
        diagnostics.push({
          id: green.id,
          position: copyPosition(green.position),
          reward,
          confidence,
          pickupDistance: Infinity,
          deliveryDistance: Infinity,
          estimatedDeliveredValue: 0,
          reachableFromMe: false,
          reachableRedAfterPickup: false,
          rejectionReason: "zero_reward"
        });
        return null;
      }
      if (confidence < config.minParcelConfidence) {
        diagnostics.push({
          id: green.id,
          position: copyPosition(green.position),
          reward,
          confidence,
          pickupDistance: Infinity,
          deliveryDistance: Infinity,
          estimatedDeliveredValue: 0,
          reachableFromMe: false,
          reachableRedAfterPickup: false,
          rejectionReason: "low_score"
        });
        return null;
      }

      const score = greenScores.get(green.id) ?? 0;
      const pickupDistance = distanceFromMe(state, green.position);
      const deliveryDistance = nearestRedDistance(state, green.position);
      const reachableFromMe = Number.isFinite(pickupDistance);
      const reachableRedAfterPickup = Number.isFinite(deliveryDistance);
      const deliveryOverrides = bestSinglePackageDeliveryOverrides(state);
      const deliveredBaseValue = reachableFromMe && reachableRedAfterPickup
        ? packageConfidence(green) * adjustPickupBaseValue(
          Math.max(0, reward - packageDecayRate(green, config.decayRate) * (pickupDistance + deliveryDistance)),
          state,
          green.position
        )
        : 0;
      const estimatedDeliveredValue = reachableFromMe && reachableRedAfterPickup
        ? estimateDeliveredValueForSinglePackage({
          deliveredBaseValue,
          state,
          deliveryPosition: green.position,
          count: 1,
          deliveryOverrides
        })
        : 0;

      if (!reachableFromMe || !reachableRedAfterPickup) {
        diagnostics.push({
          id: green.id,
          position: copyPosition(green.position),
          reward,
          confidence,
          pickupDistance,
          deliveryDistance,
          estimatedDeliveredValue,
          reachableFromMe,
          reachableRedAfterPickup,
          rejectionReason: reachableFromMe ? "no_reachable_red_after_pickup" : "unreachable_from_me"
        });
        return null;
      }

      const win = winProbability(state, green, pickupDistance, config);
      if (win <= EPSILON) {
        diagnostics.push({
          id: green.id,
          position: copyPosition(green.position),
          reward,
          confidence,
          pickupDistance,
          deliveryDistance,
          estimatedDeliveredValue,
          reachableFromMe,
          reachableRedAfterPickup,
          rejectionReason: "enemy_wins_race"
        });
        return null;
      }

      const priority = estimatedDeliveredValue / (1 + pickupDistance + deliveryDistance);
      return {
        green,
        score,
        priority,
        distanceFromMe: pickupDistance,
        distanceToRed: deliveryDistance,
        pickupDistance,
        deliveryDistance,
        adjustedReward: adjustDeliveredParcelBaseValue(
          packageConfidence(green) * adjustPickupBaseValue(reward, state, green.position),
          state
        ),
        estimatedDeliveredValue
      };
    })
    .filter(Boolean)
    .filter((entry) => Number.isFinite(entry.priority))
    .sort((a, b) => b.priority - a.priority || b.score - a.score || a.green.id.localeCompare(b.green.id));

  const maxCandidateGreens = Math.max(0, Math.round(asNumber(config.maxCandidateGreens, entries.length)));
  if (maxCandidateGreens === 0) {
    state.__candidateSelectionDiagnostics = diagnostics;
    return [];
  }

  const topGlobal = entries.slice(0, Math.max(0, Math.round(asNumber(config.topK, 0))));
  const localRadius = Math.max(0, asNumber(config.localCandidateRadius, DEFAULT_PARAMS.localCandidateRadius));
  const localLimit = Math.max(0, Math.round(asNumber(config.localCandidateLimit, DEFAULT_PARAMS.localCandidateLimit)));
  const clusterRadius = Math.max(
    0,
    asNumber(config.clusterExpansionRadius, asNumber(config.clusterPickupRadius, DEFAULT_PARAMS.clusterExpansionRadius))
  );
  const clusterLimit = Math.max(0, Math.round(asNumber(config.clusterExpansionLimit, DEFAULT_PARAMS.clusterExpansionLimit)));
  const selected = [];
  const selectedIds = new Set();

  const addEntry = (entry) => {
    if (!entry || selectedIds.has(entry.green.id)) return false;
    selectedIds.add(entry.green.id);
    selected.push(entry.green);
    return true;
  };

  for (const entry of topGlobal) addEntry(entry);

  if (localLimit > 0) {
    let added = 0;
    for (const entry of entries) {
      if (entry.distanceFromMe > localRadius) continue;
      if (addEntry(entry)) added += 1;
      if (added >= localLimit) break;
    }
  }

  if (clusterLimit > 0 && clusterRadius > 0) {
    let added = 0;
    for (const seed of topGlobal) {
      for (const entry of entries) {
        if (selectedIds.has(entry.green.id)) continue;
        const seedDistance = (state.__mapProfile?.hasDirectionalTiles)
          ? rankingDistance(state, seed.green.position, entry.green.position)
          : manhattan(seed.green.position, entry.green.position);
        if (!Number.isFinite(seedDistance) || seedDistance > clusterRadius) continue;
        if (addEntry(entry)) added += 1;
        if (added >= clusterLimit) break;
      }
      if (added >= clusterLimit) break;
    }
  }

  const result = selected.slice(0, maxCandidateGreens);
  const selectedSet = new Set(result.map((green) => green.id));
  for (const entry of entries) {
    if (selectedSet.has(entry.green.id)) continue;
    diagnostics.push({
      id: entry.green.id,
      position: copyPosition(entry.green.position),
      reward: packageReward(entry.green, config.meanPackageValue),
      adjustedReward: entry.adjustedReward,
      confidence: packageConfidence(entry.green),
      pickupDistance: entry.pickupDistance,
      deliveryDistance: entry.deliveryDistance,
      estimatedDeliveredValue: entry.estimatedDeliveredValue,
      reachableFromMe: true,
      reachableRedAfterPickup: true,
      rejectionReason: "low_score"
    });
  }
  state.__candidateSelectionDiagnostics = diagnostics;
  return result;
}
