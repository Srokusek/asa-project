import { readFile } from "node:fs/promises";

import { chatTools } from "./tool-definitions.js";
import { resolveTileSelector } from "./tile-selector.js";
import { PDDL_MAP_REGISTRY } from "../pddl/map-registry.js";
import { parsePddlPlan } from "../pddl/plan-parser.js";
import { solvePddl } from "../pddl/planner-client.js";
import { buildPddlProblem } from "../pddl/problem-builder.js";
import { buildTeammateSyncMessage } from "../utils/teammate-sync.js";
import { manhattan, positionKey } from "../utils/geometry.js";

const PDDL_DOMAIN_URL = new URL("../pddl/test_domain.pddl", import.meta.url);
const VALID_PDDL_SECTORS = new Set(["l1", "l2", "l3"]);

function asToolError(toolName, message, extra = {}) {
  return {
    ok: false,
    toolName,
    message,
    ...extra
  };
}

function asToolSuccess(toolName, message, extra = {}) {
  return {
    ok: true,
    toolName,
    message,
    ...extra
  };
}

function parseJsonArguments(raw, errorMessage) {
  try {
    return { ok: true, value: JSON.parse(raw ?? "{}") };
  } catch (_error) {
    return { ok: false, error: errorMessage };
  }
}

function validateSectorRoutingArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, reason: "invalid_payload" };
  }

  const allowedKeys = new Set(["requiredSectors", "forbiddenSectors"]);
  const extraKey = Object.keys(args).find((key) => !allowedKeys.has(key));
  if (extraKey) {
    return { ok: false, reason: `unknown_field:${extraKey}` };
  }
  if (!Array.isArray(args.requiredSectors) || !Array.isArray(args.forbiddenSectors)) {
    return { ok: false, reason: "sector_constraints_must_be_arrays" };
  }

  for (const [name, sectors] of [
    ["requiredSectors", args.requiredSectors],
    ["forbiddenSectors", args.forbiddenSectors]
  ]) {
    const invalidSector = sectors.find((sector) => !VALID_PDDL_SECTORS.has(sector));
    if (invalidSector !== undefined) {
      return { ok: false, reason: `${name}_contains_unknown_sector:${String(invalidSector)}` };
    }
  }

  const forbiddenSet = new Set(args.forbiddenSectors);
  const conflict = args.requiredSectors.find((sector) => forbiddenSet.has(sector));
  if (conflict) {
    return { ok: false, reason: `sector_both_required_and_forbidden:${conflict}` };
  }

  return {
    ok: true,
    value: {
      requiredSectors: [...new Set(args.requiredSectors)],
      forbiddenSectors: [...new Set(args.forbiddenSectors)]
    }
  };
}

function evaluateArithmeticExpression(rawExpression) {
  const expression = String(rawExpression ?? "").trim();
  if (!expression) return { ok: false, reason: "empty_expression" };
  if (!/^[0-9+\-*/().\s]+$/.test(expression)) {
    return { ok: false, reason: "invalid_token" };
  }

  try {
    const value = Function(`"use strict"; return (${expression});`)();
    if (!Number.isFinite(Number(value))) {
      return { ok: false, reason: "division_by_zero" };
    }
    return { ok: true, value: Number(value) };
  } catch (_error) {
    return { ok: false, reason: "invalid_expression" };
  }
}

function parseTargetValue(target) {
  const x = Math.round(Number(target?.x));
  const y = Math.round(Number(target?.y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function parseSelectorValue(selector) {
  if (!selector || typeof selector !== "object" || Array.isArray(selector)) {
    return { ok: false, reason: "invalid_selector" };
  }
  const extreme = String(selector.extreme ?? "").trim().toLowerCase();
  const scope = selector.scope === undefined ? null : String(selector.scope).trim().toLowerCase();
  if (!extreme) return { ok: false, reason: "missing_selector_extreme" };
  return {
    ok: true,
    value: {
      extreme,
      ...(scope ? { scope } : {})
    }
  };
}

function parsePositiveMultiplier(args) {
  const factor = Number(args?.multiplier ?? args?.factor ?? args?.value);
  if (!Number.isFinite(factor) || factor <= 0) return null;
  return factor;
}

function parseNonNegativeMultiplier(args) {
  const factor = Number(args?.multiplier ?? args?.factor ?? args?.value);
  if (!Number.isFinite(factor) || factor < 0) return null;
  return factor;
}

function parseSignedBonus(args) {
  const bonus = Number(args?.bonus ?? args?.value);
  if (!Number.isFinite(bonus)) return null;
  return bonus;
}

function parsePositiveIntegerCount(args) {
  const count = Math.round(Number(args?.count));
  if (!Number.isFinite(count) || count < 1) return null;
  return count;
}

function parseNonNegativeIntegerRadius(value, fallback = 3) {
  if (value === undefined) return fallback;
  const radius = Math.round(Number(value));
  if (!Number.isFinite(radius) || radius < 0) return null;
  return radius;
}

function parseThresholdComparison(args) {
  const comparison = String(args?.comparison ?? "").trim().toLowerCase();
  if (!["gt", "lt"].includes(comparison)) return null;
  return comparison;
}

function parseFiniteThreshold(args) {
  const threshold = Number(args?.threshold);
  if (!Number.isFinite(threshold)) return null;
  return threshold;
}

export function compactToolArgs(args) {
  if (!args || typeof args !== "object") return args ?? null;
  const json = JSON.stringify(args);
  if (json.length <= 500) return args;
  return { truncated: true, bytes: json.length };
}

export function createToolExecutor({ beliefs, executor, logger, config }) {
  const llmConfig = config?.llm ?? {};
  const teammateId = config?.teammateId ?? null;
  const maxCalculatorExpressions = Math.max(1, Number(llmConfig.maxCalculatorExpressions ?? 12) || 12);
  const maxCalculatorExpressionLength = Math.max(8, Number(llmConfig.maxCalculatorExpressionLength ?? 120) || 120);

  function tileAt(position) {
    return beliefs.tiles.get(`${position.x},${position.y}`) ?? null;
  }

  function tileTypeAt(position) {
    return String(tileAt(position)?.type ?? "0");
  }

  function isKnownWall(position) {
    const tile = tileAt(position);
    return tile?.type === "0" || tile?.blocked === true || tile?.walkable === false;
  }

  function inBounds(position) {
    if (beliefs.width <= 0 || beliefs.height <= 0) return true;
    return position.x >= 0 && position.y >= 0 && position.x < beliefs.width && position.y < beliefs.height;
  }

  function movementCandidatesFrom(position) {
    return [
      { x: position.x + 1, y: position.y, direction: "right" },
      { x: position.x - 1, y: position.y, direction: "left" },
      { x: position.x, y: position.y + 1, direction: "up" },
      { x: position.x, y: position.y - 1, direction: "down" }
    ];
  }

  async function moveAwayFromTile(position) {
    const from = { x: Math.round(Number(position.x)), y: Math.round(Number(position.y)) };
    const candidates = movementCandidatesFrom(from).filter((candidate) => {
      if (!inBounds(candidate)) return false;
      if (isKnownWall(candidate)) return false;
      if (beliefs.isTemporarilyBlocked?.(candidate)) return false;
      if (beliefs.isForbiddenTile?.(candidate)) return false;
      return true;
    });

    for (const candidate of candidates) {
      const moved = await executor.move({
        type: "move",
        direction: candidate.direction,
        from,
        to: { x: candidate.x, y: candidate.y },
        reason: "leave_tile_before_forbid"
      });
      if (moved !== false) {
        return { ok: true, to: { x: candidate.x, y: candidate.y } };
      }
    }

    return { ok: false };
  }

  async function syncToolResultWithTeammate({ type, entry }) {
    if (!teammateId || !entry) return;

    const message = buildTeammateSyncMessage({ type, entry });
    if (!message) return;

    try {
      const status = await executor.writeMessage({
        toId: teammateId,
        message
      });
      if (status === false) {
        logger.warn("teammate tool sync failed", {
          teammateId,
          type,
          entry
        });
      }
    } catch (error) {
      logger.warn("teammate tool sync failed", {
        teammateId,
        type,
        entry,
        error: error.message
      });
    }
  }

  function validateWalkableTarget(target, { rejectForbidden = true } = {}) {
    if (!inBounds(target)) return { ok: false, reason: "out_of_bounds", details: target };
    if (isKnownWall(target)) return { ok: false, reason: "blocked_target", details: target };
    if (rejectForbidden && beliefs.isForbiddenTile?.(target)) {
      return { ok: false, reason: "forbidden_target", details: target };
    }
    return { ok: true };
  }

  function validateTargetForScope(target, scope, options = {}) {
    const walkable = validateWalkableTarget(target, options);
    if (!walkable.ok) return walkable;
    if (scope === "pickup" && tileTypeAt(target) !== "1") {
      return { ok: false, reason: "invalid_target_scope", details: { target, scope } };
    }
    if (scope === "delivery" && tileTypeAt(target) !== "2") {
      return { ok: false, reason: "invalid_target_scope", details: { target, scope } };
    }
    return { ok: true };
  }

  function validateCoordinateTarget(target) {
    if (!target) return { ok: false, reason: "invalid_coordinates" };
    if (!inBounds(target)) return { ok: false, reason: "out_of_bounds", details: target };
    return { ok: true };
  }

  function nearestWalkableTileFromSelf() {
    const selfPosition = beliefs.me ? parseTargetValue(beliefs.me) : null;
    if (!selfPosition) {
      return { ok: false, reason: "missing_self_position" };
    }

    const candidates = [];
    for (let y = 0; y < beliefs.height; y += 1) {
      for (let x = 0; x < beliefs.width; x += 1) {
        const candidate = { x, y };
        if (!validateWalkableTarget(candidate).ok) continue;
        candidates.push(candidate);
      }
    }

    if (candidates.length === 0) {
      return { ok: false, reason: "no_walkable_tiles" };
    }

    candidates.sort((a, b) =>
      manhattan(a, selfPosition) - manhattan(b, selfPosition) ||
      a.y - b.y ||
      a.x - b.x
    );

    return { ok: true, value: candidates[0] };
  }

  function resolveToolTarget(args, { defaultScope, allowedScopes, rejectForbidden = true } = {}) {
    const hasTarget = args?.target !== undefined;
    const hasSelector = args?.selector !== undefined;
    if (hasTarget && hasSelector) return { ok: false, reason: "target_selector_conflict" };
    if (!hasTarget && !hasSelector) return { ok: false, reason: "missing_target" };

    if (hasTarget) {
      const target = parseTargetValue(args.target);
      if (!target) return { ok: false, reason: "invalid_coordinates" };
      const validation = validateWalkableTarget(target, { rejectForbidden });
      if (!validation.ok) return validation;
      return {
        ok: true,
        value: {
          target,
          selector: null,
          resolvedFromSelector: false
        }
      };
    }

    const selector = parseSelectorValue(args.selector);
    if (!selector.ok) return selector;
    const scope = selector.value.scope ?? defaultScope;
    if (!allowedScopes.includes(scope)) {
      return { ok: false, reason: "invalid_selector_scope", details: { selector: selector.value, allowedScopes } };
    }
    const resolved = resolveTileSelector({
      beliefs,
      config,
      selector: {
        ...selector.value,
        scope
      }
    });
    if (!resolved.ok) return resolved;
    const validation = validateTargetForScope(resolved.target, scope, { rejectForbidden });
    if (!validation.ok) return validation;
    return {
      ok: true,
      value: {
        target: resolved.target,
        selector: resolved.selector,
        resolvedFromSelector: true
      }
    };
  }

  function validateExplicitPlanArgs(args) {
    if (!args || args.goalType !== "goto_tile") return { ok: false, reason: "unsupported_goal_type" };

    const hasTargets = Array.isArray(args.targets) && args.targets.length > 0;
    if (hasTargets && (args.target !== undefined || args.selector !== undefined)) {
      return { ok: false, reason: "target_selector_conflict" };
    }

    const targets = [];
    let resolvedSelector = null;

    if (hasTargets) {
      for (const targetValue of args.targets) {
        const target = parseTargetValue(targetValue);
        if (!target) return { ok: false, reason: "invalid_coordinates" };
        const validation = validateTargetForScope(target, "walkable");
        if (!validation.ok) return validation;
        targets.push(target);
      }
    } else {
      const resolvedTarget = resolveToolTarget(args, {
        defaultScope: "walkable",
        allowedScopes: ["walkable"]
      });
      if (!resolvedTarget.ok) return resolvedTarget;
      targets.push(resolvedTarget.value.target);
      resolvedSelector = resolvedTarget.value.selector;
    }

    return {
      ok: true,
      value: {
        goalType: "goto_tile",
        targets,
        selector: resolvedSelector,
        reason: String(args.reason ?? "manual_explicit_plan"),
        priority: args.priority === "override_once" ? "override_once" : "sticky_until_done"
      }
    };
  }

  function validateTeamRendezvousArgs(args) {
    const target = parseTargetValue(args?.target);
    const targetValidation = validateCoordinateTarget(target);
    if (!targetValidation.ok) return targetValidation;

    const maxDistance = parseNonNegativeIntegerRadius(args?.maxDistance, 3);
    if (maxDistance === null) return { ok: false, reason: "invalid_max_distance" };

    return {
      ok: true,
      value: {
        target,
        maxDistance,
        reason: String(args?.reason ?? "team_rendezvous_instruction")
      }
    };
  }

  function validateParcelHandoffArgs(args) {
    if (args?.target !== undefined) {
      const target = parseTargetValue(args.target);
      if (!target) return { ok: false, reason: "invalid_coordinates" };
      const validation = validateTargetForScope(target, "walkable");
      if (!validation.ok) return validation;
      return {
        ok: true,
        value: {
          target,
          autoSelected: false,
          reason: String(args?.reason ?? "parcel_handoff_instruction")
        }
      };
    }

    const autoTarget = nearestWalkableTileFromSelf();
    if (!autoTarget.ok) return autoTarget;
    return {
      ok: true,
      value: {
        target: autoTarget.value,
        autoSelected: true,
        reason: String(args?.reason ?? "parcel_handoff_instruction")
      }
    };
  }

  function listRendezvousCandidates(center, maxDistance) {
    const candidates = [];
    const seen = new Set();
    const minX = beliefs.width > 0 ? Math.max(0, center.x - maxDistance) : center.x - maxDistance;
    const maxX = beliefs.width > 0 ? Math.min(beliefs.width - 1, center.x + maxDistance) : center.x + maxDistance;
    const minY = beliefs.height > 0 ? Math.max(0, center.y - maxDistance) : center.y - maxDistance;
    const maxY = beliefs.height > 0 ? Math.min(beliefs.height - 1, center.y + maxDistance) : center.y + maxDistance;

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const candidate = { x, y };
        if (manhattan(candidate, center) > maxDistance) continue;
        if (!validateWalkableTarget(candidate).ok) continue;
        const key = positionKey(candidate);
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(candidate);
      }
    }

    candidates.sort((a, b) =>
      manhattan(a, center) - manhattan(b, center) ||
      a.y - b.y ||
      a.x - b.x
    );
    return candidates;
  }

  function selectRendezvousTargets(center, maxDistance) {
    const candidates = listRendezvousCandidates(center, maxDistance);
    if (candidates.length < 2) {
      return { ok: false, reason: "insufficient_walkable_tiles", details: { target: center, maxDistance } };
    }

    const selfPosition = beliefs.me ? parseTargetValue(beliefs.me) : null;
    const selfKey = selfPosition ? positionKey(selfPosition) : null;
    const localTarget = (selfKey && candidates.find((candidate) => positionKey(candidate) === selfKey)) ?? candidates[0];
    const teammateTarget = candidates.find((candidate) => positionKey(candidate) !== positionKey(localTarget)) ?? null;
    if (!teammateTarget) {
      return { ok: false, reason: "insufficient_walkable_tiles", details: { target: center, maxDistance } };
    }

    return {
      ok: true,
      value: {
        localTarget,
        teammateTarget,
        candidates
      }
    };
  }

  function validateParityLineWaitArgs(args) {
    const axis = String(args?.axis ?? "").trim().toLowerCase();
    const parity = String(args?.parity ?? "").trim().toLowerCase();
    if (!["row", "column"].includes(axis)) return { ok: false, reason: "invalid_axis" };
    if (!["odd", "even"].includes(parity)) return { ok: false, reason: "invalid_parity" };
    return {
      ok: true,
      value: {
        axis,
        parity,
        reason: String(args?.reason ?? "parity_line_wait_instruction")
      }
    };
  }

  function listParityLineCandidates({ axis, parity }) {
    const candidates = [];
    const expected = parity === "odd" ? 1 : 0;
    for (let y = 0; y < beliefs.height; y += 1) {
      for (let x = 0; x < beliefs.width; x += 1) {
        const candidate = { x, y };
        if (!validateWalkableTarget(candidate).ok) continue;
        const coordinate = axis === "row" ? y : x;
        if (Math.abs(coordinate % 2) !== expected) continue;
        candidates.push(candidate);
      }
    }
    return candidates;
  }

  function sortCandidatesByAnchor(candidates, anchor) {
    return [...candidates].sort((a, b) =>
      manhattan(a, anchor) - manhattan(b, anchor) ||
      a.y - b.y ||
      a.x - b.x
    );
  }

  function selectDistinctCandidate(candidates, anchor, occupiedKeys = new Set()) {
    const sorted = sortCandidatesByAnchor(candidates, anchor);
    return sorted.find((candidate) => !occupiedKeys.has(positionKey(candidate))) ?? sorted[0] ?? null;
  }

  function knownAgentPosition(agentId) {
    const agent = beliefs.agents.get(String(agentId));
    if (!agent) return null;
    const x = Math.round(Number(agent.x));
    const y = Math.round(Number(agent.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  }

  function selectParityLineTargets({ axis, parity }) {
    const candidates = listParityLineCandidates({ axis, parity });
    if (candidates.length === 0) {
      return { ok: false, reason: "no_matching_walkable_tiles", details: { axis, parity } };
    }

    const selfPosition = beliefs.me ? parseTargetValue(beliefs.me) : null;
    if (!selfPosition) {
      return { ok: false, reason: "missing_self_position", details: { axis, parity } };
    }

    const localTarget = selectDistinctCandidate(candidates, selfPosition);
    if (!localTarget) {
      return { ok: false, reason: "no_matching_walkable_tiles", details: { axis, parity } };
    }

    const teammatePosition = teammateId ? knownAgentPosition(teammateId) : null;
    const occupiedKeys = new Set([positionKey(localTarget)]);
    const teammateAnchor = teammatePosition ?? selfPosition;
    const teammateTarget =
      selectDistinctCandidate(candidates, teammateAnchor, occupiedKeys) ??
      localTarget;

    return {
      ok: true,
      value: {
        localTarget,
        teammateTarget,
        candidateCount: candidates.length
      }
    };
  }

  function validateForbiddenTileArgs(args, { allowCurrentTile = false } = {}) {
    if (!args || (args.goalType && args.goalType !== "forbid_tile")) return { ok: false, reason: "unsupported_goal_type" };
    const resolvedTarget = resolveToolTarget(args, {
      defaultScope: "walkable",
      allowedScopes: ["walkable"],
      rejectForbidden: false
    });
    if (!resolvedTarget.ok) return resolvedTarget;
    const { target, selector } = resolvedTarget.value;
    if (
      !allowCurrentTile &&
      beliefs.me &&
      Math.round(Number(beliefs.me.x)) === target.x &&
      Math.round(Number(beliefs.me.y)) === target.y
    ) {
      return { ok: false, reason: "cannot_forbid_current_tile", details: target };
    }
    return {
      ok: true,
      value: {
        target,
        selector,
        reason: String(args.reason ?? "negative_reward_instruction")
      }
    };
  }

  function validateTileNumericRuleArgs(args, { valueParser, defaultReason, scope }) {
    const targetValidation = resolveToolTarget(args, {
      defaultScope: scope,
      allowedScopes: [scope]
    });
    if (!targetValidation.ok) return targetValidation;
    const numericValue = valueParser(args);
    if (numericValue === null) {
      return { ok: false, reason: defaultReason.includes("multiplier") ? "invalid_multiplier" : "invalid_bonus" };
    }
    return {
      ok: true,
      value: {
        target: targetValidation.value.target,
        selector: targetValidation.value.selector,
        resolvedFromSelector: targetValidation.value.resolvedFromSelector,
        numericValue,
        reason: String(args.reason ?? defaultReason)
      }
    };
  }

  function validateDeliveryCountMultiplierArgs(args) {
    const count = parsePositiveIntegerCount(args);
    if (count === null) return { ok: false, reason: "invalid_count" };
    const factor = parseNonNegativeMultiplier(args);
    if (factor === null) return { ok: false, reason: "invalid_multiplier" };
    return {
      ok: true,
      value: {
        count,
        multiplier: factor,
        reason: String(args.reason ?? "delivery_count_reward_multiplier_instruction")
      }
    };
  }

  function validateDeliveryCountBonusArgs(args) {
    const count = parsePositiveIntegerCount(args);
    if (count === null) return { ok: false, reason: "invalid_count" };
    const bonus = parseSignedBonus(args);
    if (bonus === null) return { ok: false, reason: "invalid_bonus" };
    return {
      ok: true,
      value: {
        count,
        bonus,
        reason: String(args.reason ?? "delivery_count_reward_bonus_instruction")
      }
    };
  }

  function validateDeliveryValueThresholdMultiplierArgs(args) {
    const comparison = parseThresholdComparison(args);
    if (!comparison) return { ok: false, reason: "invalid_comparison" };
    const threshold = parseFiniteThreshold(args);
    if (threshold === null) return { ok: false, reason: "invalid_threshold" };
    const multiplier = parseNonNegativeMultiplier(args);
    if (multiplier === null) return { ok: false, reason: "invalid_multiplier" };
    return {
      ok: true,
      value: {
        comparison,
        threshold,
        multiplier,
        reason: String(args.reason ?? "delivery_value_threshold_multiplier_instruction")
      }
    };
  }

  function validateCalculatorArgs(args) {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return { ok: false, reason: "invalid_payload" };
    }
    const expressions = args.expressions;
    if (!expressions || typeof expressions !== "object" || Array.isArray(expressions)) {
      return { ok: false, reason: "missing_expressions" };
    }
    const entries = Object.entries(expressions);
    if (entries.length === 0) return { ok: false, reason: "empty_expressions" };
    if (entries.length > maxCalculatorExpressions) {
      return { ok: false, reason: "too_many_expressions", details: { max: maxCalculatorExpressions } };
    }
    const keyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
    for (const [key, expr] of entries) {
      if (!keyPattern.test(key)) return { ok: false, reason: "invalid_expression_key", details: { key } };
      if (typeof expr !== "string") return { ok: false, reason: "invalid_expression_type", details: { key } };
      const trimmed = expr.trim();
      if (!trimmed) return { ok: false, reason: "empty_expression", details: { key } };
      if (trimmed.length > maxCalculatorExpressionLength) {
        return {
          ok: false,
          reason: "expression_too_long",
          details: { key, maxLength: maxCalculatorExpressionLength }
        };
      }
    }
    return { ok: true, value: { expressions } };
  }

  const tileRuleConfigs = {
    set_pickup_tile_multiplier: {
      validationMessage: "I could not parse pickup multiplier request. Please include tile and multiplier.",
      rejectLabel: "Pickup multiplier",
      successMessage: (entry) => `Pickup multiplier set at (${entry.x},${entry.y}) to ${entry.multiplier}x.`,
      defaultReason: "planner_reward_multiplier_instruction",
      scope: "pickup",
      valueParser: parsePositiveMultiplier,
      apply(target, value, meta) {
        return beliefs.setPickupTileMultiplier(target, value, meta);
      },
      syncType: "pickup_tile_multiplier_set",
      resultKey: "pickupMultiplierRule"
    },
    set_pickup_tile_bonus: {
      validationMessage: "I could not parse pickup bonus request. Please include tile and bonus.",
      rejectLabel: "Pickup bonus",
      successMessage: (entry) => `Pickup bonus set at (${entry.x},${entry.y}) to ${entry.bonus}.`,
      defaultReason: "planner_reward_bonus_instruction",
      scope: "pickup",
      valueParser: parseSignedBonus,
      apply(target, value, meta) {
        return beliefs.setPickupTileBonus(target, value, meta);
      },
      syncType: "pickup_tile_bonus_set",
      resultKey: "pickupBonusRule"
    },
    set_delivery_tile_multiplier: {
      validationMessage: "I could not parse delivery multiplier request. Please include tile and multiplier.",
      rejectLabel: "Delivery multiplier",
      successMessage: (entry) => `Delivery multiplier set at (${entry.x},${entry.y}) to ${entry.multiplier}x.`,
      defaultReason: "delivery_tile_reward_multiplier_instruction",
      scope: "delivery",
      valueParser: parsePositiveMultiplier,
      apply(target, value, meta) {
        return beliefs.setDeliveryTileMultiplier(target, value, meta);
      },
      syncType: "delivery_tile_multiplier_set",
      resultKey: "deliveryMultiplierRule"
    },
    set_delivery_tile_bonus: {
      validationMessage: "I could not parse delivery bonus request. Please include tile and bonus.",
      rejectLabel: "Delivery bonus",
      successMessage: (entry) => `Delivery bonus set at (${entry.x},${entry.y}) to ${entry.bonus}.`,
      defaultReason: "delivery_tile_reward_bonus_instruction",
      scope: "delivery",
      valueParser: parseSignedBonus,
      apply(target, value, meta) {
        return beliefs.setDeliveryTileBonus(target, value, meta);
      },
      syncType: "delivery_tile_bonus_set",
      resultKey: "deliveryBonusRule"
    }
  };

  const countRuleConfigs = {
    set_delivery_count_multiplier: {
      validationMessage: "I could not parse delivery count multiplier request. Please include count and multiplier.",
      rejectLabel: "Delivery count multiplier",
      validate: validateDeliveryCountMultiplierArgs,
      successMessage: (entry) => `Delivery count multiplier set for ${entry.count} package(s) to ${entry.multiplier}x.`,
      apply(count, value, meta) {
        return beliefs.setDeliveryCountMultiplier(count, value, meta);
      },
      syncType: "delivery_count_multiplier_set",
      resultKey: "deliveryCountMultiplierRule",
      valueKey: "multiplier"
    },
    set_delivery_count_bonus: {
      validationMessage: "I could not parse delivery count bonus request. Please include count and bonus.",
      rejectLabel: "Delivery count bonus",
      validate: validateDeliveryCountBonusArgs,
      successMessage: (entry) => `Delivery count bonus set for ${entry.count} package(s) to ${entry.bonus}.`,
      apply(count, value, meta) {
        return beliefs.setDeliveryCountBonus(count, value, meta);
      },
      syncType: "delivery_count_bonus_set",
      resultKey: "deliveryCountBonusRule",
      valueKey: "bonus"
    }
  };

  async function executeTileRuleTool(toolName, parsedValue, { senderId, sourceChatId }) {
    const configEntry = tileRuleConfigs[toolName];
    const validation = validateTileNumericRuleArgs(parsedValue, configEntry);
    if (!validation.ok) {
      return asToolError(toolName, `${configEntry.rejectLabel} rejected: ${validation.reason}.`, {
        toolArgs: parsedValue,
        data: { reason: validation.reason, details: validation.details ?? null }
      });
    }

    const entry = configEntry.apply(validation.value.target, validation.value.numericValue, {
      reason: validation.value.reason,
      sourceChatId: Number(sourceChatId ?? 0) || null,
      senderId
    });
    if (!entry) {
      return asToolError(toolName, `${configEntry.rejectLabel} rejected: invalid_payload.`, {
        toolArgs: parsedValue,
        data: { reason: "invalid_payload" }
      });
    }
    await syncToolResultWithTeammate({ type: configEntry.syncType, entry });
    return asToolSuccess(toolName, configEntry.successMessage(entry), {
      [configEntry.resultKey]: entry,
      toolArgs: parsedValue,
      data: {
        [configEntry.resultKey]: entry,
        resolvedTarget: validation.value.target,
        selector: validation.value.selector
      }
    });
  }

  async function executeCountRuleTool(toolName, parsedValue, { senderId, sourceChatId }) {
    const configEntry = countRuleConfigs[toolName];
    const validation = configEntry.validate(parsedValue);
    if (!validation.ok) {
      return asToolError(toolName, `${configEntry.rejectLabel} rejected: ${validation.reason}.`, {
        toolArgs: parsedValue,
        data: { reason: validation.reason, details: validation.details ?? null }
      });
    }
    const entry = configEntry.apply(validation.value.count, validation.value[configEntry.valueKey], {
      reason: validation.value.reason,
      sourceChatId: Number(sourceChatId ?? 0) || null,
      senderId
    });
    if (!entry) {
      return asToolError(toolName, `${configEntry.rejectLabel} rejected: invalid_payload.`, {
        toolArgs: parsedValue,
        data: { reason: "invalid_payload" }
      });
    }
    await syncToolResultWithTeammate({ type: configEntry.syncType, entry });
    return asToolSuccess(toolName, configEntry.successMessage(entry), {
      [configEntry.resultKey]: entry,
      toolArgs: parsedValue,
      data: { [configEntry.resultKey]: entry }
    });
  }

  async function executeDeliveryValueThresholdRuleTool(parsedValue, { senderId, sourceChatId }) {
    const toolName = "set_delivery_value_threshold_multiplier";
    const validation = validateDeliveryValueThresholdMultiplierArgs(parsedValue);
    if (!validation.ok) {
      return asToolError(toolName, `Delivery value threshold multiplier rejected: ${validation.reason}.`, {
        toolArgs: parsedValue,
        data: { reason: validation.reason, details: validation.details ?? null }
      });
    }

    const entry = beliefs.setDeliveryValueThresholdMultiplier(
      validation.value.comparison,
      validation.value.threshold,
      validation.value.multiplier,
      {
        reason: validation.value.reason,
        sourceChatId: Number(sourceChatId ?? 0) || null,
        senderId
      }
    );
    if (!entry) {
      return asToolError(toolName, "Delivery value threshold multiplier rejected: invalid_payload.", {
        toolArgs: parsedValue,
        data: { reason: "invalid_payload" }
      });
    }

    return asToolSuccess(
      toolName,
      `Delivery value threshold multiplier set: ${entry.comparison} ${entry.threshold} -> ${entry.multiplier}x.`,
      {
        deliveryValueThresholdRule: entry,
        toolArgs: parsedValue,
        data: { deliveryValueThresholdRule: entry }
      }
    );
  }

  async function executeTeamRendezvousTool(parsedValue, { senderId, sourceChatId }) {
    const toolName = "set_team_rendezvous_task";
    if (!teammateId) {
      return asToolError(toolName, "Rendezvous rejected: missing_teammate_id.", {
        toolArgs: parsedValue,
        data: { reason: "missing_teammate_id" }
      });
    }

    const validation = validateTeamRendezvousArgs(parsedValue);
    if (!validation.ok) {
      return asToolError(toolName, `Rendezvous rejected: ${validation.reason}.`, {
        toolArgs: parsedValue,
        data: { reason: validation.reason, details: validation.details ?? null }
      });
    }

    const selection = selectRendezvousTargets(validation.value.target, validation.value.maxDistance);
    if (!selection.ok) {
      return asToolError(toolName, `Rendezvous rejected: ${selection.reason}.`, {
        toolArgs: parsedValue,
        data: { reason: selection.reason, details: selection.details ?? null }
      });
    }

    const taskKey = `team_rendezvous:${beliefs.time}:${beliefs.manualTaskSequence + 1}`;
    const sourceChat = Number(sourceChatId ?? 0) || null;
    const localPlan = beliefs.pushManualTask({
      type: "goto_tile",
      sourceChatId: sourceChat,
      senderId,
      priority: "sticky_until_done",
      payload: {
        target: selection.value.localTarget,
        reason: validation.value.reason,
        goalType: "goto_tile",
        kind: "team_rendezvous",
        taskKey,
        waitAtTarget: true,
        center: validation.value.target,
        maxDistance: validation.value.maxDistance
      }
    });

    await syncToolResultWithTeammate({
      type: "manual_task_set",
      entry: {
        type: "goto_tile",
        sourceChatId: sourceChat,
        senderId,
        priority: "sticky_until_done",
        payload: {
          target: selection.value.teammateTarget,
          reason: validation.value.reason,
          goalType: "goto_tile",
          kind: "team_rendezvous",
          taskKey,
          waitAtTarget: true,
          center: validation.value.target,
          maxDistance: validation.value.maxDistance
        }
      }
    });

    return asToolSuccess(
      toolName,
      `Rendezvous accepted: self -> (${selection.value.localTarget.x},${selection.value.localTarget.y}), teammate -> (${selection.value.teammateTarget.x},${selection.value.teammateTarget.y}).`,
      {
        plan: localPlan,
        toolArgs: parsedValue,
        data: {
          target: validation.value.target,
          maxDistance: validation.value.maxDistance,
          localTarget: selection.value.localTarget,
          teammateTarget: selection.value.teammateTarget,
          taskKey
        }
      }
    );
  }

  async function executeParityLineWaitTool(parsedValue, { senderId, sourceChatId }) {
    const toolName = "set_parity_line_wait_task";
    if (!teammateId) {
      return asToolError(toolName, "Parity wait rejected: missing_teammate_id.", {
        toolArgs: parsedValue,
        data: { reason: "missing_teammate_id" }
      });
    }

    const validation = validateParityLineWaitArgs(parsedValue);
    if (!validation.ok) {
      return asToolError(toolName, `Parity wait rejected: ${validation.reason}.`, {
        toolArgs: parsedValue,
        data: { reason: validation.reason, details: validation.details ?? null }
      });
    }

    const selection = selectParityLineTargets(validation.value);
    if (!selection.ok) {
      return asToolError(toolName, `Parity wait rejected: ${selection.reason}.`, {
        toolArgs: parsedValue,
        data: { reason: selection.reason, details: selection.details ?? null }
      });
    }

    const taskKey = `parity_line_wait:${beliefs.time}:${beliefs.manualTaskSequence + 1}`;
    const sourceChat = Number(sourceChatId ?? 0) || null;
    const localPlan = beliefs.pushManualTask({
      type: "goto_tile",
      sourceChatId: sourceChat,
      senderId,
      priority: "sticky_until_done",
      payload: {
        target: selection.value.localTarget,
        reason: validation.value.reason,
        goalType: "goto_tile",
        kind: "parity_line_wait",
        taskKey,
        waitAtTarget: true,
        axis: validation.value.axis,
        parity: validation.value.parity
      }
    });

    await syncToolResultWithTeammate({
      type: "manual_task_set",
      entry: {
        type: "goto_tile",
        sourceChatId: sourceChat,
        senderId,
        priority: "sticky_until_done",
        payload: {
          target: selection.value.teammateTarget,
          reason: validation.value.reason,
          goalType: "goto_tile",
          kind: "parity_line_wait",
          taskKey,
          waitAtTarget: true,
          axis: validation.value.axis,
          parity: validation.value.parity
        }
      }
    });

    return asToolSuccess(
      toolName,
      `Parity wait accepted: self -> (${selection.value.localTarget.x},${selection.value.localTarget.y}), teammate -> (${selection.value.teammateTarget.x},${selection.value.teammateTarget.y}).`,
      {
        plan: localPlan,
        toolArgs: parsedValue,
        data: {
          axis: validation.value.axis,
          parity: validation.value.parity,
          localTarget: selection.value.localTarget,
          teammateTarget: selection.value.teammateTarget,
          candidateCount: selection.value.candidateCount,
          taskKey
        }
      }
    );
  }

  async function executeParcelHandoffTool(parsedValue, { senderId, sourceChatId }) {
    const toolName = "set_parcel_handoff";
    if (!teammateId) {
      return asToolError(toolName, "Parcel handoff rejected: missing_teammate_id.", {
        toolArgs: parsedValue,
        data: { reason: "missing_teammate_id" }
      });
    }

    const validation = validateParcelHandoffArgs(parsedValue);
    if (!validation.ok) {
      return asToolError(toolName, `Parcel handoff rejected: ${validation.reason}.`, {
        toolArgs: parsedValue,
        data: { reason: validation.reason, details: validation.details ?? null }
      });
    }

    const sourceChat = Number(sourceChatId ?? 0) || null;
    const entry = beliefs.setPickupTileTask(validation.value.target, {
      reason: validation.value.reason,
      sourceChatId: sourceChat,
      senderId
    });
    if (!entry) {
      return asToolError(toolName, "Parcel handoff rejected: invalid_payload.", {
        toolArgs: parsedValue,
        data: { reason: "invalid_payload" }
      });
    }

    await syncToolResultWithTeammate({
      type: "set_delivery_tile",
      entry
    });

    return asToolSuccess(
      toolName,
      `Parcel handoff set at (${entry.target.x},${entry.target.y}).`,
      {
        parcelPickupTileTask: entry,
        toolArgs: parsedValue,
        data: {
          parcelPickupTileTask: entry,
          target: entry.target,
          autoSelected: validation.value.autoSelected
        }
      }
    );
  }

  async function executeToolCall(call, { senderId, sourceChatId }) {
    const toolName = String(call?.function?.name ?? "").trim();
    const rawArgs = call?.function?.arguments;

    if (toolName === "calculate_expressions") {
      const parsed = parseJsonArguments(rawArgs, "I could not parse calculator input. Please provide an expressions object.");
      if (!parsed.ok) return asToolError(toolName, parsed.error);
      const validation = validateCalculatorArgs(parsed.value);
      if (!validation.ok) {
        return asToolError(toolName, `Calculator input rejected: ${validation.reason}.`, {
          toolArgs: parsed.value,
          data: { reason: validation.reason, details: validation.details ?? null }
        });
      }

      const results = {};
      for (const [key, expression] of Object.entries(validation.value.expressions)) {
        const evaluation = evaluateArithmeticExpression(expression);
        if (!evaluation.ok) {
          return asToolError(toolName, `Calculator failed for '${key}': ${evaluation.reason}.`, {
            toolArgs: parsed.value,
            data: { reason: evaluation.reason, key, details: evaluation.details ?? null }
          });
        }
        results[key] = evaluation.value;
      }

      return asToolSuccess(toolName, `Calculated ${Object.keys(results).join(", ")}.`, {
        toolArgs: parsed.value,
        data: { results, expressionCount: Object.keys(results).length }
      });
    }

    if (toolName === "solve_sector_routing") {
      const parsed = parseJsonArguments(
        rawArgs,
        "I could not parse the sector-routing constraints."
      );
      if (!parsed.ok) return asToolError(toolName, parsed.error);

      const validation = validateSectorRoutingArgs(parsed.value);
      if (!validation.ok) {
        return asToolError(toolName, `Sector routing rejected: ${validation.reason}.`, {
          toolArgs: parsed.value,
          data: { reason: validation.reason }
        });
      }

      const constraints = validation.value;
      try {
        const [domain, problem] = await Promise.all([
          readFile(PDDL_DOMAIN_URL, "utf8"),
          buildPddlProblem(constraints)
        ]);
        const result = await solvePddl({
          domain,
          problem,
          endpoint: config?.pddl?.endpoint,
          timeoutMs: config?.pddl?.timeoutMs,
          logFile: config?.pddl?.logFile,
          logger
        });

        if (!result.solutionPlan) {
          return asToolError(toolName, "The PDDL planner found no solution.", {
            toolArgs: constraints,
            data: {
              reason: "no_solution",
              status: result.status,
              constraints,
              solutionPlan: null
            }
          });
        }

        let parsedPlan;
        try {
          parsedPlan = parsePddlPlan(result.solutionPlan, PDDL_MAP_REGISTRY);
        } catch (error) {
          return asToolError(
            toolName,
            `The PDDL planner result could not be parsed: ${error.message}`,
            {
              toolArgs: constraints,
              data: {
                reason: "plan_parse_error",
                status: result.status,
                constraints,
                solutionPlan: result.solutionPlan
              }
            }
          );
        }

        
        return asToolSuccess(toolName, "PDDL sector-routing solution received.", {
          toolArgs: constraints,
          data: {
            status: result.status,
            constraints,
            solutionPlan: result.solutionPlan,
            parsedPlan
          }
        });
      } catch (error) {
        return asToolError(toolName, `PDDL sector routing failed: ${error.message}`, {
          toolArgs: constraints,
          data: {
            reason: "planner_error",
            constraints
          }
        });
      }
    }

    if (toolName === "set_explicit_plan") {
      const parsed = parseJsonArguments(rawArgs, "I could not parse your plan request. Please provide a tile like (x,y).");
      if (!parsed.ok) return asToolError(toolName, parsed.error);
      beliefs.advanceTimeFromClock();
      const validation = validateExplicitPlanArgs(parsed.value);
      if (!validation.ok) {
        return asToolError(toolName, `Plan rejected: ${validation.reason}.`, {
          planError: validation.reason,
          toolArgs: parsed.value,
          data: { reason: validation.reason, details: validation.details ?? null }
        });
      }

      const plans = [];
      for (const [index, target] of validation.value.targets.entries()) {
        const isFinalTarget = index === validation.value.targets.length - 1;
        const shouldWaitAtTarget = isFinalTarget && validation.value.priority === "sticky_until_done";
        const plan = beliefs.pushManualTask({
          type: "goto_tile",
          sourceChatId: Number(sourceChatId ?? 0) || null,
          senderId,
          priority: shouldWaitAtTarget ? "sticky_until_done" : "override_once",
          payload: {
            target,
            reason: validation.value.reason,
            goalType: validation.value.goalType,
            ...(shouldWaitAtTarget ? { waitAtTarget: true } : {})
          }
        });
        plans.push(plan);
      }

      return asToolSuccess(
        toolName,
        plans.length === 1
          ? `Plan accepted: moving to (${plans[0].payload.target.x},${plans[0].payload.target.y}).`
          : `Plan accepted: queued ${plans.length} steps (${plans
              .map((plan) => `(${plan.payload.target.x},${plan.payload.target.y})`)
              .join(" -> ")}).`,
        {
          plan: plans[0] ?? null,
          plans,
          toolArgs: parsed.value,
          data: {
            goalType: validation.value.goalType,
            targets: validation.value.targets,
            selector: validation.value.selector,
            planIds: plans.map((plan) => plan.id)
          }
        }
      );
    }

    if (toolName === "set_team_rendezvous_task") {
      const parsed = parseJsonArguments(rawArgs, "I could not parse the rendezvous request. Please provide a tile like (x,y).");
      if (!parsed.ok) return asToolError(toolName, parsed.error);
      beliefs.advanceTimeFromClock();
      return executeTeamRendezvousTool(parsed.value, { senderId, sourceChatId });
    }

    if (toolName === "set_parity_line_wait_task") {
      const parsed = parseJsonArguments(
        rawArgs,
        "I could not parse the parity wait request. Please specify axis='row' or 'column' and parity='odd' or 'even'."
      );
      if (!parsed.ok) return asToolError(toolName, parsed.error);
      beliefs.advanceTimeFromClock();
      return executeParityLineWaitTool(parsed.value, { senderId, sourceChatId });
    }

    if (toolName === "set_parcel_handoff") {
      const parsed = parseJsonArguments(
        rawArgs,
        "I could not parse the parcel handoff request. Please provide an optional tile like (x,y)."
      );
      if (!parsed.ok) return asToolError(toolName, parsed.error);
      beliefs.advanceTimeFromClock();
      return executeParcelHandoffTool(parsed.value, { senderId, sourceChatId });
    }

    if (toolName === "set_forbidden_tile") {
      const parsed = parseJsonArguments(
        rawArgs,
        "I could not parse the forbidden tile request. Please provide a tile like (x,y)."
      );
      if (!parsed.ok) return asToolError(toolName, parsed.error);

      const validation = validateForbiddenTileArgs(parsed.value, { allowCurrentTile: true });
      if (!validation.ok) {
        logger.warn("forbidden tile rejected", {
          senderId,
          chatId: sourceChatId,
          reason: validation.reason,
          target: validation?.details ?? validation?.value?.target ?? null
        });
        beliefs.pushEvent("FORBIDDEN_TILE_REJECTED", {
          senderId,
          chatId: Number(sourceChatId ?? 0) || null,
          reason: validation.reason,
          target: validation?.details ?? null
        });
        return asToolError(toolName, `Forbidden-tile instruction rejected: ${validation.reason}.`, {
          toolArgs: parsed.value,
          data: { reason: validation.reason, details: validation.details ?? null }
        });
      }

      if (
        beliefs.me &&
        Math.round(Number(beliefs.me.x)) === validation.value.target.x &&
        Math.round(Number(beliefs.me.y)) === validation.value.target.y
      ) {
        const moveResult = await moveAwayFromTile(validation.value.target);
        if (!moveResult.ok) {
          logger.warn("forbidden tile rejected", {
            senderId,
            chatId: sourceChatId,
            reason: "cannot_leave_tile_before_forbid",
            target: validation.value.target
          });
          beliefs.pushEvent("FORBIDDEN_TILE_REJECTED", {
            senderId,
            chatId: Number(sourceChatId ?? 0) || null,
            reason: "cannot_leave_tile_before_forbid",
            target: validation.value.target
          });
          return asToolError(toolName, "Forbidden-tile instruction rejected: cannot_leave_tile_before_forbid.", {
            toolArgs: parsed.value,
            data: { reason: "cannot_leave_tile_before_forbid" }
          });
        }
      }

      const created = beliefs.setForbiddenTile(validation.value.target, {
        reason: validation.value.reason,
        sourceChatId: Number(sourceChatId ?? 0) || null,
        senderId
      });
      logger.info("forbidden tile added", {
        senderId,
        chatId: sourceChatId,
        tile: validation.value.target,
        reason: validation.value.reason
      });
      return asToolSuccess(toolName, `Forbidden tile set at (${created.x},${created.y}). I will avoid it.`, {
        forbiddenTile: created,
        toolArgs: parsed.value,
        data: { forbiddenTile: created, selector: validation.value.selector }
      });
    }

    if (tileRuleConfigs[toolName]) {
      const parsed = parseJsonArguments(rawArgs, tileRuleConfigs[toolName].validationMessage);
      if (!parsed.ok) return asToolError(toolName, parsed.error);
      return executeTileRuleTool(toolName, parsed.value, { senderId, sourceChatId });
    }

    if (countRuleConfigs[toolName]) {
      const parsed = parseJsonArguments(rawArgs, countRuleConfigs[toolName].validationMessage);
      if (!parsed.ok) return asToolError(toolName, parsed.error);
      return executeCountRuleTool(toolName, parsed.value, { senderId, sourceChatId });
    }

    if (toolName === "set_delivery_value_threshold_multiplier") {
      const parsed = parseJsonArguments(
        rawArgs,
        "I could not parse delivery value threshold multiplier request. Please include comparison, threshold, and multiplier."
      );
      if (!parsed.ok) return asToolError(toolName, parsed.error);
      return executeDeliveryValueThresholdRuleTool(parsed.value, { senderId, sourceChatId });
    }

    return asToolError(
      toolName || "unknown_tool",
      `Unknown tool '${toolName}'. Available tools: ${chatTools.map((tool) => tool.function.name).join(", ")}.`
    );
  }

  return {
    executeToolCall
  };
}
