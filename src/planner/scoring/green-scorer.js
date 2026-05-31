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

const EPSILON = 1e-9;

export function sigmoid(x) {
  if (x >= 40) return 1;
  if (x <= -40) return 0;
  return 1 / (1 + Math.exp(-x));
}

export function logSumExp(C, F, k) {
  if (k <= EPSILON) return Math.max(C, F);
  const maxValue = Math.max(C, F);
  return maxValue + Math.log(Math.exp(k * (C - maxValue)) + Math.exp(k * (F - maxValue))) / k;
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
  for (const enemy of state.enemies) {
    const speed = Math.max(EPSILON, asNumber(enemy.speed, 1));
    const enemyEta = rankingDistance(state, enemy.position, green.position) / speed;
    probability = Math.min(probability, sigmoid(config.kWin * (enemyEta - etaMe)));
  }
  return probability;
}

function generationProbabilityForGreen(state, config) {
  const greenCount = Math.max(1, state.greens.length);
  if (config.generationProbability !== null && config.generationProbability !== undefined) {
    return clamp(asNumber(config.generationProbability, 0), 0, 1) / greenCount;
  }
  if (config.generationMeanTime !== null && config.generationMeanTime !== undefined) {
    return 1 / Math.max(1, asNumber(config.generationMeanTime, 1)) / greenCount;
  }
  return 1 / greenCount;
}

function expectedGenerationWait(config) {
  if (config.generationMeanTime !== null && config.generationMeanTime !== undefined) {
    return Math.max(0, asNumber(config.generationMeanTime, 0));
  }
  if (config.generationProbability !== null && config.generationProbability !== undefined) {
    const p = clamp(asNumber(config.generationProbability, 0), 0, 1);
    return p > EPSILON ? 1 / p : Infinity;
  }
  return 0;
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

export function pickupMultiplierAt(state, position) {
  const key = positionKey(copyPosition(position));
  const raw = state.pickupTileMultipliers?.[key];
  const value = asNumber(raw?.multiplier ?? raw, 1);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

export function deliveryMultiplierAt(state, position) {
  const key = positionKey(copyPosition(position));
  const raw = state.deliveryTileMultipliers?.[key];
  const value = asNumber(raw?.multiplier ?? raw, 1);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

export function deliveryCountMultiplierAt(state, count) {
  const normalizedCount = Math.round(Number(count));
  if (!Number.isFinite(normalizedCount) || normalizedCount < 1) return 1;
  const raw = state.deliveryCountMultipliers?.[String(normalizedCount)];
  const value = asNumber(raw?.multiplier ?? raw, 1);
  return Number.isFinite(value) && value >= 0 ? value : 1;
}

function bestDeliveryMultiplier(state) {
  if (!Array.isArray(state.reds) || state.reds.length === 0) return 1;
  let best = 1;
  for (const red of state.reds) {
    best = Math.max(best, deliveryMultiplierAt(state, red.position));
  }
  return best;
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
  const adjustedValue = deliveryAwareValue * pickupMultiplierAt(state, green.position) * bestDeliveryMultiplier(state);
  return packageConfidence(green) * winProbability(state, green, etaMe, config) * adjustedValue;
}

export function futureGreenValue(state, green, config) {
  if (!green.package && config.emptyGreenFutureWeight <= EPSILON) return 0;

  const etaMe = rankingDistance(state, state.me.position, green.position);
  if (!Number.isFinite(etaMe)) return 0;

  const etaRed = nearestRedDistance(state, green.position);
  if (!Number.isFinite(etaRed)) return 0;

  const wait = expectedGenerationWait(config);
  if (!Number.isFinite(wait)) return 0;

  const travelAfterSpawn = etaMe + etaRed;
  const expectedValue = Math.max(0, config.meanPackageValue - config.decayRate * travelAfterSpawn);
  const q = generationProbabilityForGreen(state, config);
  return q * expectedValue * Math.exp(-config.rhoGeneration * wait);
}

export function computeGreenScore(state, green, config) {
  const C = currentGreenValue(state, green, config);
  const F = futureGreenValue(state, green, config);
  return logSumExp(C, F, config.kSmoothMax);
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
      const multiplier = pickupMultiplierAt(state, green.position) * bestDeliveryMultiplier(state);
      const estimatedDeliveredValue = reachableFromMe && reachableRedAfterPickup
        ? (reward - packageDecayRate(green, config.decayRate) * (pickupDistance + deliveryDistance)) * multiplier
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
        adjustedReward: reward * multiplier,
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
