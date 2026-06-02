import { asNumber, copyPosition, positionKey } from "../planner/path/grid-utils.js";

function objectFromRules(value) {
  if (!value) return {};
  if (value instanceof Map) return Object.fromEntries(value);
  if (typeof value === "object" && !Array.isArray(value)) return value;
  return {};
}

function multiplierForKey(source, key, fallback = 1) {
  const raw = objectFromRules(source)[key];
  if (raw === undefined || raw === null) return fallback;
  const value = asNumber(raw?.multiplier ?? raw, fallback);
  return Number.isFinite(value) ? value : fallback;
}

function combineMultiplier(...values) {
  return values.reduce((acc, value) => acc * (Number.isFinite(Number(value)) ? Number(value) : 1), 1);
}

function combinedRules(state) {
  const deliveryRules = state?.deliveryRules ?? {};
  return {
    stackRules: [
      ...(Array.isArray(state?.stackRules) ? state.stackRules : []),
      ...(Array.isArray(deliveryRules.stackRules) ? deliveryRules.stackRules : [])
    ],
    forbiddenDeliveryCounts: [
      ...(Array.isArray(state?.forbiddenDeliveryCounts) ? state.forbiddenDeliveryCounts : []),
      ...(Array.isArray(deliveryRules.forbiddenDeliveryCounts) ? deliveryRules.forbiddenDeliveryCounts : [])
    ],
    parcelValueFilters: [
      ...(Array.isArray(state?.parcelValueFilters) ? state.parcelValueFilters : []),
      ...(Array.isArray(deliveryRules.parcelValueFilters) ? deliveryRules.parcelValueFilters : [])
    ],
    deliveryTileMultipliers: {
      ...objectFromRules(state?.deliveryTileMultipliers),
      ...objectFromRules(deliveryRules.deliveryTileMultipliers)
    },
    deliveryCountMultipliers: {
      ...objectFromRules(state?.deliveryCountMultipliers),
      ...objectFromRules(deliveryRules.deliveryCountMultipliers)
    }
  };
}

function valueAtDelivery(pkg, deliveryTime, config) {
  const pickupTime = asNumber(pkg.pickupTime, asNumber(config?.time, 0));
  const decayRate = asNumber(pkg.decayRate, asNumber(config?.decayRate, 0));
  const base = asNumber(pkg.valueAtPickup ?? pkg.value ?? pkg.reward, 0);
  return Math.max(0, base - decayRate * Math.max(0, asNumber(deliveryTime, 0) - pickupTime));
}

function checkStackRules(rules, count) {
  const satisfied = [];
  const violated = [];
  let multiplier = 1;
  let allowed = true;

  for (const rule of rules.stackRules) {
    const expected = Math.round(Number(rule.count));
    if (!Number.isFinite(expected) || expected < 1) continue;
    const matches = count === expected;
    const record = { ...rule, expected, actual: count };
    if (matches) {
      satisfied.push(record);
      if (Number.isFinite(Number(rule.multiplier))) multiplier *= Number(rule.multiplier);
    } else {
      violated.push(record);
      if (rule.hard === true || rule.kind === "STACK_EXACTLY_N") allowed = false;
    }
  }

  for (const rule of rules.forbiddenDeliveryCounts) {
    const forbidden = Math.round(Number(rule.count));
    if (Number.isFinite(forbidden) && forbidden === count) {
      allowed = false;
      violated.push({ ...rule, kind: "FORBIDDEN_DELIVERY_COUNT", actual: count });
    }
  }

  return { allowed, multiplier, satisfied, violated };
}

function checkParcelValueFilters(filters, packageValues) {
  const satisfied = [];
  const violated = [];
  let allowed = true;

  for (const filter of filters) {
    const minValue = Number.isFinite(Number(filter.minValue)) ? Number(filter.minValue) : null;
    const maxValue = Number.isFinite(Number(filter.maxValue)) ? Number(filter.maxValue) : null;
    const failing = packageValues.filter((value) => {
      if (minValue !== null && value < minValue) return true;
      if (maxValue !== null && value > maxValue) return true;
      return false;
    });
    const record = { ...filter, failingCount: failing.length };
    if (failing.length === 0) {
      satisfied.push(record);
    } else {
      violated.push(record);
      if (filter.hard !== false) allowed = false;
    }
  }

  return { allowed, satisfied, violated };
}

export function evaluateDelivery({ state, packages, deliveryTime, deliveryPosition, config = {} }) {
  const pickedPackages = Array.isArray(packages) ? packages : [];
  const count = pickedPackages.length;
  const key = positionKey(copyPosition(deliveryPosition ?? { x: 0, y: 0 }));
  const rules = combinedRules(state);
  const values = pickedPackages.map((pkg) => valueAtDelivery(pkg, deliveryTime, config));
  const stack = checkStackRules(rules, count);
  const valueFilters = checkParcelValueFilters(rules.parcelValueFilters, values);
  const deliveryTileMultiplier = multiplierForKey(rules.deliveryTileMultipliers, key, 1);
  const deliveryCountMultiplier = multiplierForKey(rules.deliveryCountMultipliers, String(count), 1);
  const multiplier = combineMultiplier(deliveryTileMultiplier, deliveryCountMultiplier, stack.multiplier);
  const allowed = stack.allowed && valueFilters.allowed;
  const value = allowed ? values.reduce((sum, value) => sum + value * multiplier, 0) : 0;

  return {
    allowed,
    value,
    multiplier,
    reason: allowed ? "allowed" : "delivery_rules_violated",
    violatedRules: [...stack.violated, ...valueFilters.violated],
    satisfiedRules: [
      ...stack.satisfied,
      ...valueFilters.satisfied,
      { kind: "DELIVERY_TILE_MULTIPLIER", multiplier: deliveryTileMultiplier, key },
      { kind: "DELIVERY_COUNT_MULTIPLIER", multiplier: deliveryCountMultiplier, count }
    ]
  };
}
