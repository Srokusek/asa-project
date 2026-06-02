import { evaluateDelivery } from "../missions/reward-model.js";
import { asNumber, buildMapProfile, copyPosition } from "../planner/path/grid-utils.js";
import { shortestGridPath } from "../planner/path/pathfinder.js";
import { packageConfidence, packageDecayRate, packageReward } from "../planner/scoring/green-scorer.js";

function carriedValueNow(carriedPackages = [], currentTime = 0) {
  return carriedPackages.reduce((sum, pkg) => {
    const elapsed = Math.max(0, asNumber(currentTime, 0) - asNumber(pkg.pickupTime, currentTime));
    const value = Math.max(0, asNumber(pkg.valueAtPickup ?? pkg.value, 0) - asNumber(pkg.decayRate, 0) * elapsed);
    return sum + value * asNumber(pkg.confidence, 1);
  }, 0);
}

function nearestRedInfo(state, config) {
  const profile = state.__mapProfile ?? buildMapProfile(state);
  let best = null;
  const start = copyPosition(state.me?.position ?? { x: 0, y: 0 });

  for (const red of state.reds ?? []) {
    const edge = shortestGridPath(state, start, red.position, profile);
    if (!Number.isFinite(edge.cost)) continue;
    if (!best || edge.cost < best.distance) {
      best = { red, distance: edge.cost, path: edge.path };
    }
  }

  return best ?? { red: null, distance: Infinity, path: [] };
}

function visibleReliablePickup(green, state, config) {
  if (!green?.package || green.package.carriedBy) return false;
  const confidence = packageConfidence(green);
  const lastSeen = asNumber(green.package.lastSeenTime, -Infinity);
  const visible = confidence >= 1 || lastSeen >= asNumber(state.time, 0);
  return visible && confidence >= asNumber(config.minParcelConfidence, 0.3);
}

function nearbyPickupSummary(state, config) {
  const profile = state.__mapProfile ?? buildMapProfile(state);
  const start = copyPosition(state.me?.position ?? { x: 0, y: 0 });
  const radius = Math.max(0, asNumber(config.deliveryDeferralNearbyRadius, asNumber(config.clusterPickupRadius, 4)));
  let nearbyPickupValue = 0;
  let nearbyPickupCount = 0;
  let nearestPickupDistance = Infinity;

  for (const green of state.greens ?? []) {
    if (!visibleReliablePickup(green, state, config)) continue;
    const edge = shortestGridPath(state, start, green.position, profile);
    if (!Number.isFinite(edge.cost) || edge.cost > radius) continue;
    const arrivalTime = asNumber(state.time, 0) + edge.cost;
    const value =
      Math.max(
        0,
        packageReward(green, config.meanPackageValue) -
          packageDecayRate(green, config.decayRate) * Math.max(0, arrivalTime - asNumber(state.time, 0))
      ) * packageConfidence(green);
    if (value <= 0) continue;
    nearbyPickupValue += value;
    nearbyPickupCount += 1;
    nearestPickupDistance = Math.min(nearestPickupDistance, edge.cost);
  }

  return {
    nearbyPickupCount,
    nearbyPickupValue,
    nearestPickupDistance
  };
}

function stackRuleStatus(state, carriedCount) {
  const exactRules = (state.stackRules ?? []).filter((rule) => String(rule.kind ?? "").toUpperCase() === "STACK_EXACTLY_N");
  if (exactRules.length === 0) return { status: "none", rule: null, targetCount: null };

  const hardRule = exactRules.find((rule) => rule.hard === true) ?? exactRules[0];
  const targetCount = Math.round(Number(hardRule.count));
  if (!Number.isFinite(targetCount) || targetCount < 1) return { status: "none", rule: null, targetCount: null };
  if (carriedCount === targetCount) return { status: "satisfied", rule: hardRule, targetCount };
  if (carriedCount < targetCount) return { status: "needs_more_packages", rule: hardRule, targetCount };
  return { status: hardRule.hard === true ? "excess_packages_hard_invalid" : "excess_packages", rule: hardRule, targetCount };
}

export function shouldDeliverNow(plannerState, _missionRules = null, config = {}) {
  const carriedPackages = plannerState.carriedPackages ?? [];
  const carriedCount = carriedPackages.length;
  const carriedValue = carriedValueNow(carriedPackages, plannerState.time);
  const redInfo = nearestRedInfo(plannerState, config);
  const nearby = nearbyPickupSummary(plannerState, config);
  const stack = stackRuleStatus(plannerState, carriedCount);

  const base = {
    shouldDeliver: false,
    deliveryForbidden: false,
    deliveryDeferred: false,
    reason: "no_carried_packages",
    carriedCount,
    carriedValue,
    nearestRedDistance: redInfo.distance,
    nearbyPickupValue: nearby.nearbyPickupValue,
    nearbyPickupCount: nearby.nearbyPickupCount,
    nearestPickupDistance: nearby.nearestPickupDistance,
    stackRuleStatus: stack.status,
    stackTargetCount: stack.targetCount,
    deliveryValue: 0,
    deliveryAllowed: false,
    deliveryEvaluation: null
  };

  if (carriedCount === 0) return base;
  if (!redInfo.red || !Number.isFinite(redInfo.distance)) {
    return { ...base, reason: "no_reachable_red" };
  }

  const deliveryEval = evaluateDelivery({
    state: plannerState,
    packages: carriedPackages,
    deliveryTime: asNumber(plannerState.time, 0) + redInfo.distance,
    deliveryPosition: redInfo.red.position,
    config
  });

  const withDelivery = {
    ...base,
    deliveryValue: deliveryEval.value,
    deliveryAllowed: deliveryEval.allowed,
    deliveryEvaluation: deliveryEval
  };

  if (!deliveryEval.allowed) {
    return {
      ...withDelivery,
      deliveryForbidden: true,
      reason:
        stack.status === "needs_more_packages" && nearby.nearbyPickupCount > 0
          ? "stack_rule_not_satisfied_and_nearby_pickups"
          : stack.status === "needs_more_packages"
          ? "stack_rule_not_satisfied"
          : stack.status === "excess_packages_hard_invalid"
            ? "stack_rule_excess_packages"
            : "delivery_rules_disallow"
    };
  }

  if (stack.status === "satisfied") {
    return {
      ...withDelivery,
      shouldDeliver: true,
      reason: "stack_exact_satisfied"
    };
  }

  const minNearbyValue = asNumber(config.deliveryDeferralMinNearbyValue, 1);
  const redIsClose = redInfo.distance <= asNumber(config.deliveryDeferralCloseRedDistance, 2);
  const pickupLooksWorthIt =
    nearby.nearbyPickupCount > 0 &&
    nearby.nearbyPickupValue >= minNearbyValue &&
    nearby.nearestPickupDistance <= redInfo.distance + 1;

  if (stack.status === "needs_more_packages" && pickupLooksWorthIt) {
    return {
      ...withDelivery,
      deliveryDeferred: true,
      reason: "stack_rule_not_satisfied_and_nearby_pickups"
    };
  }

  if (!redIsClose && pickupLooksWorthIt && nearby.nearbyPickupValue > carriedValue * 0.25) {
    return {
      ...withDelivery,
      deliveryDeferred: true,
      reason: "nearby_pickups_outweigh_delivery"
    };
  }

  return {
    ...withDelivery,
    shouldDeliver: true,
    reason: redIsClose ? "red_close" : "delivery_value_ready"
  };
}
