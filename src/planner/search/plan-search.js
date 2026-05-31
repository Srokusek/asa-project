import { DEFAULT_PARAMS } from "../default-params.js";
import { asNumber, clamp, copyPosition } from "../path/grid-utils.js";
import { getOracleEdge } from "../path/distance-oracle.js";
import {
  deliveryCountMultiplierAt,
  deliveryMultiplierAt,
  hasAvailablePackage,
  nearestRedDistance,
  packageConfidence,
  packageDecayRate,
  packageReward,
  pickupMultiplierAt,
  rankingDistance,
  winProbability
} from "../scoring/green-scorer.js";

const EPSILON = 1e-9;

export function initialPlan(state) {
  const carriedPackages = (state.carriedPackages ?? []).map((pkg) => ({
    greenId: pkg.greenId ?? "CARRIED",
    packageId: String(pkg.packageId ?? pkg.id),
    valueAtPickup:
      asNumber(pkg.valueAtPickup ?? pkg.value, 0) *
      pickupMultiplierAt(state, pkg.pickupPosition ?? { x: 0, y: 0 }),
    pickupTime: asNumber(pkg.pickupTime, asNumber(state.time, 0)),
    decayRate: asNumber(pkg.decayRate, state.params?.decayRate ?? DEFAULT_PARAMS.decayRate),
    confidence: clamp(asNumber(pkg.confidence, 1), 0, 1),
    pickupPosition: copyPosition(pkg.pickupPosition ?? { x: 0, y: 0 })
  }));

  return {
    sequence: ["START"],
    currentId: "START",
    currentPosition: copyPosition(state.me.position),
    time: asNumber(state.time, 0),
    moveCost: 0,
    pickedPackages: carriedPackages,
    pickedGreenIds: new Set(),
    deliveredScore: 0
  };
}

export function packageValueAtPickup(state, green, pickupTime, config) {
  const pkg = green.package;
  if (!pkg || pkg.carriedBy) return 0;
  const currentValue = packageReward(green, config.meanPackageValue);
  const decayRate = packageDecayRate(green, config.decayRate);
  const elapsed = Math.max(0, pickupTime - asNumber(state.time, 0));
  const pickupMultiplier = pickupMultiplierAt(state, green.position);
  return packageConfidence(green) * Math.max(0, currentValue - decayRate * elapsed) * pickupMultiplier;
}

export function beatsEnemiesToGreen(state, green, etaMe, config) {
  if (!state.enemies || state.enemies.length === 0) return true;
  const margin = asNumber(config.enemySafetyMargin, 0);
  return state.enemies.every((enemy) => {
    const speed = Math.max(EPSILON, asNumber(enemy.speed, 1));
    const enemyEta = rankingDistance(state, enemy.position, green.position) / speed;
    return etaMe + margin <= enemyEta + EPSILON;
  });
}

export function extendToGreen(plan, green, state, oracle, config) {
  if (plan.pickedGreenIds.has(green.id)) return null;
  if (!hasAvailablePackage(green, config)) return null;

  const edge = getOracleEdge(oracle, plan.currentId, green.id);
  if (!edge || !Number.isFinite(edge.cost)) return null;

  const arrivalTime = plan.time + edge.cost;
  const etaFromNow = Math.max(0, arrivalTime - asNumber(state.time, 0));
  if (!beatsEnemiesToGreen(state, green, etaFromNow, config)) return null;

  const valueAtPickup = packageValueAtPickup(state, green, arrivalTime, config);
  if (valueAtPickup <= EPSILON) return null;

  const decayRate = packageDecayRate(green, config.decayRate);
  const pickedGreenIds = new Set(plan.pickedGreenIds);
  pickedGreenIds.add(green.id);

  return {
    ...plan,
    sequence: [...plan.sequence, green.id],
    currentId: green.id,
    currentPosition: copyPosition(green.position),
    time: arrivalTime,
    moveCost: plan.moveCost + edge.cost,
    pickedPackages: [
      ...plan.pickedPackages,
      {
        greenId: green.id,
        packageId: String(green.package.id),
        valueAtPickup,
        pickupTime: arrivalTime,
        decayRate,
        confidence: packageConfidence(green),
        pickupPosition: copyPosition(green.position)
      }
    ],
    pickedGreenIds
  };
}

export function computeDeliveredValue(pickedPackages, deliveryTime, deliveryPosition, state) {
  const deliveryMultiplier = deliveryMultiplierAt(state, deliveryPosition);
  const countMultiplier = deliveryCountMultiplierAt(state, pickedPackages.length);
  const effectiveMultiplier = deliveryMultiplier * countMultiplier;
  return pickedPackages.reduce((sum, pkg) => {
    const elapsed = Math.max(0, deliveryTime - pkg.pickupTime);
    return sum + Math.max(0, pkg.valueAtPickup - pkg.decayRate * elapsed) * effectiveMultiplier;
  }, 0);
}

export function extendToRed(plan, red, _state, oracle, _config) {
  if (plan.pickedPackages.length === 0) return null;

  const edge = getOracleEdge(oracle, plan.currentId, red.id);
  if (!edge || !Number.isFinite(edge.cost)) return null;

  const deliveryTime = plan.time + edge.cost;
  const delivered = computeDeliveredValue(plan.pickedPackages, deliveryTime, red.position, _state);

  return {
    ...plan,
    sequence: [...plan.sequence, red.id],
    currentId: red.id,
    currentPosition: copyPosition(red.position),
    time: deliveryTime,
    moveCost: plan.moveCost + edge.cost,
    pickedPackages: [],
    deliveredScore: plan.deliveredScore + delivered
  };
}

export function carriedPotential(plan, _state, oracle, config = null) {
  if (plan.pickedPackages.length === 0) return 0;
  const reds = oracle.points.filter((point) => point.type === "red");
  if (reds.length === 0) return 0;

  let best = -Infinity;
  const moveWeight = asNumber(config?.moveWeight, 0);
  for (const red of reds) {
    const edge = getOracleEdge(oracle, plan.currentId, red.id);
    if (!edge || !Number.isFinite(edge.cost)) continue;
    const deliveryTime = plan.time + edge.cost;
    const delivered = computeDeliveredValue(plan.pickedPackages, deliveryTime, red.position, _state);
    best = Math.max(best, delivered - moveWeight * edge.cost);
  }
  return Number.isFinite(best) ? best : 0;
}

export function planValue(plan, state, oracle, config) {
  return (
    plan.deliveredScore +
    config.betaCarry * carriedPotential(plan, state, oracle, config) -
    config.moveWeight * plan.moveCost
  );
}

export function finalObjective(plan, config) {
  return plan.deliveredScore - config.moveWeight * plan.moveCost;
}

export function bestCompletionValue(plan, reds, state, oracle, config) {
  if (plan.pickedPackages.length === 0) return finalObjective(plan, config);

  let best = -Infinity;
  for (const red of reds) {
    const edge = getOracleEdge(oracle, plan.currentId, red.id);
    if (!edge || !Number.isFinite(edge.cost)) continue;
    const deliveryTime = plan.time + edge.cost;
    const delivered = computeDeliveredValue(plan.pickedPackages, deliveryTime, red.position, state);
    const totalMoveCost = plan.moveCost + edge.cost;
    best = Math.max(best, plan.deliveredScore + delivered - config.moveWeight * totalMoveCost);
  }

  return Number.isFinite(best) ? best : finalObjective(plan, config);
}

export function estimateNearbyPackageBonus(plan, greens, state, oracle, config) {
  let bonus = 0;
  const radius = Math.max(0, asNumber(config.clusterPickupRadius, 0));
  const minValue = asNumber(config.minClusterPackageValue, 0);

  for (const green of greens) {
    if (plan.pickedGreenIds.has(green.id)) continue;
    if (!hasAvailablePackage(green, config)) continue;

    const edge = getOracleEdge(oracle, plan.currentId, green.id);
    if (!edge || !Number.isFinite(edge.cost) || edge.cost > radius) continue;

    const pickupTime = plan.time + edge.cost;
    const valueAtPickup = packageValueAtPickup(state, green, pickupTime, config);
    if (valueAtPickup < minValue) continue;

    const redDistance = nearestRedDistance(state, green.position);
    const decayRate = packageDecayRate(green, config.decayRate);
    const deliveryAwareValue = Math.max(
      0,
      valueAtPickup - (Number.isFinite(redDistance) ? decayRate * redDistance : 0)
    );
    const net = deliveryAwareValue - config.moveWeight * edge.cost;
    if (net > 0) bonus += net;
  }

  return bonus;
}

export function partialPlanPriority(plan, greens, reds, state, oracle, config) {
  return (
    bestCompletionValue(plan, reds, state, oracle, config) +
    config.clusterPickupBonusWeight * estimateNearbyPackageBonus(plan, greens, state, oracle, config)
  );
}

export function betterPlan(a, b, state, oracle, config) {
  if (!a) return b;
  if (!b) return a;

  const aValue = a.pickedPackages.length === 0 ? finalObjective(a, config) : planValue(a, state, oracle, config);
  const bValue = b.pickedPackages.length === 0 ? finalObjective(b, config) : planValue(b, state, oracle, config);
  if (bValue > aValue + EPSILON) return b;
  if (aValue > bValue + EPSILON) return a;
  if (b.deliveredScore > a.deliveredScore + EPSILON) return b;
  if (a.deliveredScore > b.deliveredScore + EPSILON) return a;
  return b.moveCost < a.moveCost ? b : a;
}

export function findBestSequence(state, points, oracle, _greenScores, config) {
  const greens = points.filter((point) => point.type === "green");
  const reds = points.filter((point) => point.type === "red");
  let beam = [initialPlan(state)];
  let bestComplete = null;
  let bestPartial = null;
  const maxCarriedBeforeDelivery = Math.max(0, Math.round(asNumber(config.maxPickupsBeforeDelivery, 0)));

  for (let depth = 0; depth < config.maxPickupsBeforeDelivery; depth += 1) {
    const nextBeam = [];

    for (const plan of beam) {
      for (const red of reds) {
        const deliveredPlan = extendToRed(plan, red, state, oracle, config);
        if (deliveredPlan) {
          bestComplete = betterPlan(bestComplete, deliveredPlan, state, oracle, config);
        }
      }

      if (plan.pickedPackages.length < maxCarriedBeforeDelivery) {
        for (const green of greens) {
          const nextPlan = extendToGreen(plan, green, state, oracle, config);
          if (nextPlan) {
            nextBeam.push(nextPlan);
            bestPartial = betterPlan(bestPartial, nextPlan, state, oracle, config);
          }
        }
      }
    }

    nextBeam.sort(
      (a, b) =>
        partialPlanPriority(b, greens, reds, state, oracle, config) -
          partialPlanPriority(a, greens, reds, state, oracle, config) ||
        planValue(b, state, oracle, config) - planValue(a, state, oracle, config)
    );
    beam = nextBeam.slice(0, config.beamWidth);
    if (beam.length === 0) break;
  }

  for (const plan of beam) {
    for (const red of reds) {
      const deliveredPlan = extendToRed(plan, red, state, oracle, config);
      if (deliveredPlan) {
        bestComplete = betterPlan(bestComplete, deliveredPlan, state, oracle, config);
      }
    }
  }

  if (bestComplete) {
    return { ...bestComplete, value: planValue(bestComplete, state, oracle, config) };
  }

  if (bestPartial) {
    return {
      ...bestPartial,
      value: planValue(bestPartial, state, oracle, config),
      incomplete: true,
      needsDeliveryAfterPickup: true
    };
  }

  const failed = initialPlan(state);
  return {
    ...failed,
    value: planValue(failed, state, oracle, config),
    failed: true,
    failureReason: "no_valid_sequence"
  };
}
