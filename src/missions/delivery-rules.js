import { positionKey, roundTilePosition } from "../utils/geometry.js";
import { MISSION_TYPES, missionIsActive } from "./mission-spec.js";

function asMissionList(missions) {
  if (!missions) return [];
  if (missions instanceof Map) return [...missions.values()];
  return Array.isArray(missions) ? missions : [];
}

function normalizeTarget(target) {
  if (!target) return null;
  const cell = roundTilePosition(target);
  if (!Number.isFinite(cell.x) || !Number.isFinite(cell.y)) return null;
  return cell;
}

function setTileRule(targetMap, target, entry) {
  const cell = normalizeTarget(target);
  if (!cell) return;
  targetMap[positionKey(cell)] = { ...entry, x: cell.x, y: cell.y };
}

function activeSpecs(missionSpecs, currentTick = null) {
  return asMissionList(missionSpecs).filter((spec) => missionIsActive(spec, currentTick));
}

function asPriority(value, fallback = 0) {
  const priority = Number(value);
  return Number.isFinite(priority) ? priority : fallback;
}

function stackRulePriority(spec, rule = {}) {
  return asPriority(rule.priority ?? spec.priority ?? spec.objective?.priority, 0);
}

function betterStackRule(a, b) {
  if (!a) return b;
  if (b.priority !== a.priority) return b.priority > a.priority ? b : a;
  return b.order > a.order ? b : a;
}

function resolveStackRuleConflicts(stackRules) {
  const hardExact = stackRules.filter((rule) => rule.kind === "STACK_EXACTLY_N" && rule.hard === true);
  const hardCounts = new Set(hardExact.map((rule) => rule.count));
  if (hardCounts.size <= 1) {
    return { stackRules, conflicts: [] };
  }

  // Conflict policy: highest priority wins; ties are resolved by last active mission wins.
  const winner = hardExact.reduce((best, rule) => betterStackRule(best, rule), null);
  const conflicts = hardExact
    .filter((rule) => rule !== winner)
    .map((rule) => ({
      kind: "STACK_EXACTLY_N_CONFLICT",
      missionId: rule.missionId,
      count: rule.count,
      priority: rule.priority,
      resolvedByMissionId: winner.missionId,
      resolvedCount: winner.count,
      policy: "highest_priority_then_last_mission_wins"
    }));

  return {
    stackRules: stackRules.filter((rule) => rule !== winner ? !(rule.kind === "STACK_EXACTLY_N" && rule.hard === true) : true),
    conflicts
  };
}

export function buildDeliveryRules(missionSpecs = [], currentTick = null) {
  const rules = {
    stackRules: [],
    stackRuleConflicts: [],
    forbiddenDeliveryCounts: [],
    parcelValueFilters: [],
    pickupTileMultipliers: {},
    deliveryTileMultipliers: {},
    deliveryCountMultipliers: {}
  };
  const stackRules = [];
  let order = 0;

  for (const spec of activeSpecs(missionSpecs, currentTick)) {
    for (const constraint of spec.constraints ?? []) {
      const kind = String(constraint.kind ?? constraint.type ?? "").toUpperCase();
      if (kind === "STACK_EXACTLY_N") {
        const count = Math.round(Number(constraint.count ?? spec.objective?.count));
        if (Number.isFinite(count) && count > 0) {
          stackRules.push({
            kind: "STACK_EXACTLY_N",
            count,
            hard: constraint.hard !== false,
            multiplier: Number(constraint.multiplier ?? 1),
            missionId: spec.id,
            priority: stackRulePriority(spec, constraint),
            order: order += 1,
            reason: constraint.reason ?? spec.reason
          });
        }
      } else if (kind === "FORBIDDEN_DELIVERY_COUNT") {
        const count = Math.round(Number(constraint.count));
        if (Number.isFinite(count) && count > 0) {
          rules.forbiddenDeliveryCounts.push({ count, missionId: spec.id, reason: constraint.reason ?? spec.reason });
        }
      } else if (kind === "PARCEL_VALUE_FILTER") {
        rules.parcelValueFilters.push({
          minValue: Number.isFinite(Number(constraint.minValue)) ? Number(constraint.minValue) : null,
          maxValue: Number.isFinite(Number(constraint.maxValue)) ? Number(constraint.maxValue) : null,
          hard: constraint.hard !== false,
          missionId: spec.id,
          reason: constraint.reason ?? spec.reason
        });
      }
    }

    for (const modifier of spec.rewardModifiers ?? []) {
      const kind = String(modifier.kind ?? modifier.type ?? spec.type ?? "").toUpperCase();
      const multiplier = Number(modifier.multiplier ?? spec.objective?.multiplier);
      if (!Number.isFinite(multiplier)) continue;

      if (kind === "PICKUP_TILE_MULTIPLIER" || spec.type === MISSION_TYPES.PICKUP_TILE_MULTIPLIER) {
        setTileRule(rules.pickupTileMultipliers, modifier.target ?? spec.objective?.target, {
          multiplier,
          missionId: spec.id,
          reason: modifier.reason ?? spec.reason
        });
      } else if (kind === "DELIVERY_TILE_MULTIPLIER" || spec.type === MISSION_TYPES.DELIVERY_TILE_MULTIPLIER) {
        setTileRule(rules.deliveryTileMultipliers, modifier.target ?? spec.objective?.target, {
          multiplier,
          missionId: spec.id,
          reason: modifier.reason ?? spec.reason
        });
      } else if (kind === "DELIVERY_COUNT_MULTIPLIER" || spec.type === MISSION_TYPES.DELIVERY_COUNT_MULTIPLIER) {
        const count = Math.round(Number(modifier.count ?? spec.objective?.count));
        if (Number.isFinite(count) && count > 0) {
          rules.deliveryCountMultipliers[String(count)] = {
            count,
            multiplier,
            missionId: spec.id,
            reason: modifier.reason ?? spec.reason
          };
        }
      } else if (kind === "STACK_COUNT_MULTIPLIER" || spec.type === MISSION_TYPES.STACK_COUNT_MULTIPLIER) {
        const count = Math.round(Number(modifier.count ?? spec.objective?.count));
        if (Number.isFinite(count) && count > 0) {
          const existing = stackRules.find((rule) => rule.missionId === spec.id && rule.count === count && rule.kind === "STACK_EXACTLY_N");
          if (existing) {
            existing.multiplier = multiplier;
            existing.priority = Math.max(existing.priority, stackRulePriority(spec, modifier));
            continue;
          }
          stackRules.push({
            kind: "STACK_COUNT_MULTIPLIER",
            count,
            hard: false,
            multiplier,
            missionId: spec.id,
            priority: stackRulePriority(spec, modifier),
            order: order += 1,
            reason: modifier.reason ?? spec.reason
          });
        }
      }
    }
  }

  const resolved = resolveStackRuleConflicts(stackRules);
  rules.stackRules = resolved.stackRules.map(({ order: _order, ...rule }) => rule);
  rules.stackRuleConflicts = resolved.conflicts;
  return rules;
}

export function activeForbiddenTilesFromMissions(missionSpecs = [], currentTick = null) {
  const tiles = {};
  for (const spec of activeSpecs(missionSpecs, currentTick)) {
    if (spec.type !== MISSION_TYPES.FORBIDDEN_TILE && !(spec.constraints ?? []).some((rule) => String(rule.kind ?? "").toUpperCase() === "FORBIDDEN_TILE")) {
      continue;
    }
    const target =
      normalizeTarget(spec.objective?.target) ??
      normalizeTarget((spec.constraints ?? []).find((rule) => String(rule.kind ?? "").toUpperCase() === "FORBIDDEN_TILE")?.target);
    if (!target) continue;
    tiles[positionKey(target)] = {
      x: target.x,
      y: target.y,
      missionId: spec.id,
      reason: spec.reason
    };
  }
  return tiles;
}
