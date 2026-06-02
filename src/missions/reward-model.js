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

function uniqueStackRules(rules = []) {
  const seen = new Set();
  const unique = [];
  for (const rule of rules) {
    const key = [
      String(rule.kind ?? rule.type ?? "").toUpperCase(),
      rule.missionId ?? "",
      rule.count ?? "",
      rule.hard === false ? "soft" : "hard",
      rule.multiplier ?? 1
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(rule);
  }
  return unique;
}

function combinedRules(state) {
  const deliveryRules = state?.deliveryRules ?? {};
  return {
    stackRules: uniqueStackRules([
      ...(Array.isArray(state?.stackRules) ? state.stackRules : []),
      ...(Array.isArray(deliveryRules.stackRules) ? deliveryRules.stackRules : [])
    ]),
    stackRuleConflicts: [
      ...(Array.isArray(state?.stackRuleConflicts) ? state.stackRuleConflicts : []),
      ...(Array.isArray(deliveryRules.stackRuleConflicts) ? deliveryRules.stackRuleConflicts : [])
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
  const conflicts = [...(rules.stackRuleConflicts ?? [])];
  let multiplier = 1;
  let allowed = true;
  const stackRules = resolveHardStackRuleConflicts(rules.stackRules ?? [], conflicts);

  for (const rule of stackRules) {
    const expected = Math.round(Number(rule.count));
    if (!Number.isFinite(expected) || expected < 1) continue;
    const matches = count === expected;
    const record = { ...rule, expected, actual: count };
    if (matches) {
      satisfied.push(record);
      if (Number.isFinite(Number(rule.multiplier))) multiplier *= Number(rule.multiplier);
    } else {
      violated.push(record);
      if (rule.hard === true) allowed = false;
    }
  }

  for (const rule of rules.forbiddenDeliveryCounts) {
    const forbidden = Math.round(Number(rule.count));
    if (Number.isFinite(forbidden) && forbidden === count) {
      allowed = false;
      violated.push({ ...rule, kind: "FORBIDDEN_DELIVERY_COUNT", actual: count });
    }
  }

  return { allowed, multiplier, satisfied, violated, conflicts };
}

function rulePriority(rule) {
  const priority = Number(rule.priority ?? 0);
  return Number.isFinite(priority) ? priority : 0;
}

function ruleOrder(rule, index) {
  const order = Number(rule.order ?? rule.createdAtTick ?? index);
  return Number.isFinite(order) ? order : index;
}

function betterHardRule(a, b) {
  if (!a) return b;
  if (b.priority !== a.priority) return b.priority > a.priority ? b : a;
  return b.order > a.order ? b : a;
}

function resolveHardStackRuleConflicts(stackRules, conflicts) {
  const normalized = (stackRules ?? []).map((rule, index) => ({
    ...rule,
    priority: rulePriority(rule),
    order: ruleOrder(rule, index)
  }));
  const hardExact = normalized.filter((rule) => String(rule.kind ?? "").toUpperCase() === "STACK_EXACTLY_N" && rule.hard === true);
  const hardCounts = new Set(hardExact.map((rule) => Math.round(Number(rule.count))).filter((count) => Number.isFinite(count)));
  if (hardCounts.size <= 1) return normalized;

  // Conflict policy: highest priority wins; ties are resolved by last rule wins.
  const winner = hardExact.reduce((best, rule) => betterHardRule(best, rule), null);
  for (const rule of hardExact) {
    if (rule === winner) continue;
    conflicts.push({
      kind: "STACK_EXACTLY_N_CONFLICT",
      missionId: rule.missionId ?? null,
      count: Math.round(Number(rule.count)),
      priority: rule.priority,
      resolvedByMissionId: winner.missionId ?? null,
      resolvedCount: Math.round(Number(winner.count)),
      policy: "highest_priority_then_last_rule_wins"
    });
  }
  return normalized.filter((rule) => rule === winner || !(String(rule.kind ?? "").toUpperCase() === "STACK_EXACTLY_N" && rule.hard === true));
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
  const hardViolation = [...stack.violated, ...valueFilters.violated].some((rule) => rule.hard !== false);
  const reason = allowed
    ? stack.conflicts.length > 0
      ? "allowed_with_resolved_stack_conflict"
      : [...stack.violated, ...valueFilters.violated].length > 0
        ? "allowed_with_soft_rule_violations"
        : "allowed"
    : hardViolation
      ? "hard_delivery_rule_violated"
      : "delivery_rules_violated";

  return {
    allowed,
    value,
    multiplier,
    reason,
    violatedRules: [...stack.violated, ...valueFilters.violated],
    satisfiedRules: [
      ...stack.satisfied,
      ...valueFilters.satisfied,
      { kind: "DELIVERY_TILE_MULTIPLIER", multiplier: deliveryTileMultiplier, key },
      { kind: "DELIVERY_COUNT_MULTIPLIER", multiplier: deliveryCountMultiplier, count }
    ],
    conflicts: stack.conflicts
  };
}
