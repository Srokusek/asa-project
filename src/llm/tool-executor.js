import { chatTools } from "./tool-definitions.js";

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

function parseTarget(args) {
  const x = Math.round(Number(args?.target?.x));
  const y = Math.round(Number(args?.target?.y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function parseMultiplier(args) {
  const factor = Number(args?.multiplier ?? args?.factor ?? args?.value);
  if (!Number.isFinite(factor) || factor <= 0) return null;
  return factor;
}

function parseNonNegativeMultiplier(args) {
  const factor = Number(args?.multiplier ?? args?.factor ?? args?.value);
  if (!Number.isFinite(factor) || factor < 0) return null;
  return factor;
}

function parsePositiveIntegerCount(args) {
  const count = Math.round(Number(args?.count));
  if (!Number.isFinite(count) || count < 1) return null;
  return count;
}

export function compactToolArgs(args) {
  if (!args || typeof args !== "object") return args ?? null;
  const json = JSON.stringify(args);
  if (json.length <= 500) return args;
  return { truncated: true, bytes: json.length };
}

export function createToolExecutor({ beliefs, executor, logger, config }) {
  const llmConfig = config?.llm ?? {};
  const maxCalculatorExpressions = Math.max(1, Number(llmConfig.maxCalculatorExpressions ?? 12) || 12);
  const maxCalculatorExpressionLength = Math.max(8, Number(llmConfig.maxCalculatorExpressionLength ?? 120) || 120);

  function isKnownWall(position) {
    const tile = beliefs.tiles.get(`${position.x},${position.y}`);
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

  function validateExplicitPlanArgs(args) {
    if (!args || args.goalType !== "goto_tile") return { ok: false, reason: "unsupported_goal_type" };
    const targetInputs =
      Array.isArray(args.targets) && args.targets.length > 0
        ? args.targets.map((target) => ({ target }))
        : args.target
          ? [{ target: args.target }]
          : [];
    if (targetInputs.length === 0) return { ok: false, reason: "missing_target" };

    const targets = [];
    for (const item of targetInputs) {
      const parsed = parseTarget(item);
      if (!parsed) return { ok: false, reason: "invalid_coordinates" };
      const { x, y } = parsed;
      if (beliefs.width > 0 && beliefs.height > 0) {
        if (x < 0 || y < 0 || x >= beliefs.width || y >= beliefs.height) {
          return { ok: false, reason: "out_of_bounds", details: { x, y } };
        }
      }
      const tile = beliefs.tiles.get(`${x},${y}`);
      if (tile?.type === "0") return { ok: false, reason: "blocked_target", details: { x, y } };
      if (beliefs.isForbiddenTile?.({ x, y })) {
        return { ok: false, reason: "forbidden_target", details: { x, y } };
      }
      targets.push({ x, y });
    }

    return {
      ok: true,
      value: {
        goalType: "goto_tile",
        targets,
        reason: String(args.reason ?? "manual_explicit_plan"),
        priority: args.priority === "sticky_until_done" ? "sticky_until_done" : "override_once",
        expiresTicks: Math.max(1, Math.min(300, Number(args.expiresTicks ?? 120) || 120))
      }
    };
  }

  function validateForbiddenTileArgs(args, { allowCurrentTile = false } = {}) {
    if (!args || (args.goalType && args.goalType !== "forbid_tile")) return { ok: false, reason: "unsupported_goal_type" };
    const target = parseTarget(args);
    if (!target) return { ok: false, reason: "invalid_coordinates" };
    const { x, y } = target;
    if (beliefs.width > 0 && beliefs.height > 0) {
      if (x < 0 || y < 0 || x >= beliefs.width || y >= beliefs.height) {
        return { ok: false, reason: "out_of_bounds", details: { x, y } };
      }
    }
    if (
      !allowCurrentTile &&
      beliefs.me &&
      Math.round(Number(beliefs.me.x)) === x &&
      Math.round(Number(beliefs.me.y)) === y
    ) {
      return { ok: false, reason: "cannot_forbid_current_tile", details: { x, y } };
    }
    return {
      ok: true,
      value: {
        target: { x, y },
        reason: String(args.reason ?? "negative_reward_instruction")
      }
    };
  }

  function validateMultiplierArgs(args) {
    const target = parseTarget(args);
    if (!target) return { ok: false, reason: "invalid_coordinates" };
    const factor = parseMultiplier(args);
    if (factor === null) return { ok: false, reason: "invalid_multiplier" };
    if (beliefs.width > 0 && beliefs.height > 0) {
      if (target.x < 0 || target.y < 0 || target.x >= beliefs.width || target.y >= beliefs.height) {
        return { ok: false, reason: "out_of_bounds", details: target };
      }
    }
    return {
      ok: true,
      value: {
        target,
        multiplier: factor,
        reason: String(args.reason ?? "planner_reward_multiplier_instruction")
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

    if (toolName === "set_explicit_plan") {
      const parsed = parseJsonArguments(rawArgs, "I could not parse your plan request. Please provide a tile like (x,y).");
      if (!parsed.ok) return asToolError(toolName, parsed.error);
      if (typeof beliefs.advanceTimeFromClock === "function") {
        beliefs.advanceTimeFromClock();
      }
      const validation = validateExplicitPlanArgs(parsed.value);
      if (!validation.ok) {
        return asToolError(toolName, `Plan rejected: ${validation.reason}.`, {
          planError: validation.reason,
          toolArgs: parsed.value
        });
      }

      const plans = [];
      for (const target of validation.value.targets) {
        const plan = beliefs.pushManualTask({
          type: "goto_tile",
          sourceChatId: Number(sourceChatId ?? 0) || null,
          senderId,
          expiresTicks: validation.value.expiresTicks,
          priority: validation.value.priority,
          payload: {
            target,
            reason: validation.value.reason,
            goalType: validation.value.goalType
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
            planIds: plans.map((plan) => plan.id)
          }
        }
      );
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
          data: { reason: validation.reason }
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
        data: { forbiddenTile: created }
      });
    }

    if (toolName === "set_pickup_tile_multiplier") {
      const parsed = parseJsonArguments(rawArgs, "I could not parse pickup multiplier request. Please include tile and multiplier.");
      if (!parsed.ok) return asToolError(toolName, parsed.error);
      const validation = validateMultiplierArgs(parsed.value);
      if (!validation.ok) {
        return asToolError(toolName, `Pickup multiplier rejected: ${validation.reason}.`, {
          toolArgs: parsed.value,
          data: { reason: validation.reason }
        });
      }
      const entry = beliefs.setPickupTileMultiplier(validation.value.target, validation.value.multiplier, {
        reason: validation.value.reason,
        sourceChatId: Number(sourceChatId ?? 0) || null,
        senderId
      });
      if (!entry) {
        return asToolError(toolName, "Pickup multiplier rejected: invalid_multiplier.", {
          toolArgs: parsed.value,
          data: { reason: "invalid_multiplier" }
        });
      }
      return asToolSuccess(toolName, `Pickup multiplier set at (${entry.x},${entry.y}) to ${entry.multiplier}x.`, {
        pickupMultiplierRule: entry,
        toolArgs: parsed.value,
        data: { pickupMultiplierRule: entry }
      });
    }

    if (toolName === "set_delivery_tile_multiplier") {
      const parsed = parseJsonArguments(rawArgs, "I could not parse delivery multiplier request. Please include tile and multiplier.");
      if (!parsed.ok) return asToolError(toolName, parsed.error);
      const validation = validateMultiplierArgs(parsed.value);
      if (!validation.ok) {
        return asToolError(toolName, `Delivery multiplier rejected: ${validation.reason}.`, {
          toolArgs: parsed.value,
          data: { reason: validation.reason }
        });
      }
      const entry = beliefs.setDeliveryTileMultiplier(validation.value.target, validation.value.multiplier, {
        reason: validation.value.reason,
        sourceChatId: Number(sourceChatId ?? 0) || null,
        senderId
      });
      if (!entry) {
        return asToolError(toolName, "Delivery multiplier rejected: invalid_multiplier.", {
          toolArgs: parsed.value,
          data: { reason: "invalid_multiplier" }
        });
      }
      return asToolSuccess(toolName, `Delivery multiplier set at (${entry.x},${entry.y}) to ${entry.multiplier}x.`, {
        deliveryMultiplierRule: entry,
        toolArgs: parsed.value,
        data: { deliveryMultiplierRule: entry }
      });
    }

    if (toolName === "set_delivery_count_multiplier") {
      const parsed = parseJsonArguments(
        rawArgs,
        "I could not parse delivery count multiplier request. Please include count and multiplier."
      );
      if (!parsed.ok) return asToolError(toolName, parsed.error);
      const validation = validateDeliveryCountMultiplierArgs(parsed.value);
      if (!validation.ok) {
        return asToolError(toolName, `Delivery count multiplier rejected: ${validation.reason}.`, {
          toolArgs: parsed.value,
          data: { reason: validation.reason }
        });
      }
      const entry = beliefs.setDeliveryCountMultiplier(validation.value.count, validation.value.multiplier, {
        reason: validation.value.reason,
        sourceChatId: Number(sourceChatId ?? 0) || null,
        senderId
      });
      if (!entry) {
        return asToolError(toolName, "Delivery count multiplier rejected: invalid_payload.", {
          toolArgs: parsed.value,
          data: { reason: "invalid_payload" }
        });
      }
      return asToolSuccess(
        toolName,
        `Delivery count multiplier set for ${entry.count} package(s) to ${entry.multiplier}x.`,
        {
          deliveryCountMultiplierRule: entry,
          toolArgs: parsed.value,
          data: { deliveryCountMultiplierRule: entry }
        }
      );
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
