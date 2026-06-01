import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

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

function compactToolArgs(args) {
  if (!args || typeof args !== "object") return args ?? null;
  const json = JSON.stringify(args);
  if (json.length <= 500) return args;
  return { truncated: true, bytes: json.length };
}

function summarizeToolOutcomes(outcomes) {
  const successes = outcomes.filter((entry) => entry.ok);
  const failures = outcomes.filter((entry) => !entry.ok);
  return {
    successes,
    failures,
    successCount: successes.length,
    failureCount: failures.length,
    mixed: successes.length > 0 && failures.length > 0
  };
}

function buildMixedSummary(outcomes) {
  const { successCount, failureCount, failures } = summarizeToolOutcomes(outcomes);
  if (!(successCount > 0 && failureCount > 0)) return "";
  const failedTools = [...new Set(failures.map((entry) => entry.toolName).filter(Boolean))].join(", ");
  if (!failedTools) {
    return `Execution summary: ${successCount} step(s) succeeded and ${failureCount} step(s) failed.`;
  }
  return `Execution summary: ${successCount} step(s) succeeded and ${failureCount} step(s) failed (failed tools: ${failedTools}).`;
}

function buildLimitFallback(outcomes, stopReason) {
  const { successCount, failureCount } = summarizeToolOutcomes(outcomes);
  const reason = stopReason === "max_tool_calls" ? "too many tool calls" : "too many iterations";
  return `I could not complete all requested actions because the tool-planning loop reached its safety limit (${reason}). Partial progress: ${successCount} succeeded, ${failureCount} failed.`;
}

export function createChatProcessor({ beliefs, executor, logger, llmCaller = null }) {
  let lastEvaluatedChatId = 0;
  let chatClient = null;
  let chatModel = null;
  let chatLogReady = false;
  const chatDiagnosticsEnabled = process.env.CHAT_DIAGNOSTICS_ENABLED !== "0";
  const chatDiagnosticsFile = resolve(process.env.CHAT_DIAGNOSTICS_FILE || "logs/chat-diagnostics.jsonl");
  const maxToolIterations = Math.max(1, Number(process.env.CHAT_MAX_LLM_ITERATIONS ?? 8) || 8);
  const maxTotalToolCalls = Math.max(1, Number(process.env.CHAT_MAX_TOOL_CALLS ?? 16) || 16);

  async function writeChatDiagnostics(entry) {
    if (!chatDiagnosticsEnabled) return;
    try {
      if (!chatLogReady) {
        await mkdir(dirname(chatDiagnosticsFile), { recursive: true });
        chatLogReady = true;
      }
      await appendFile(
        chatDiagnosticsFile,
        `${JSON.stringify({
          ts: new Date().toISOString(),
          ...entry
        })}\n`,
        "utf8"
      );
    } catch (error) {
      logger.warn("chat diagnostics write failed", { error: error.message });
    }
  }

  const explicitPlanTool = {
    type: "function",
    function: {
      name: "set_explicit_plan",
      description: "Create an explicit manual plan for the agent.",
      parameters: {
        type: "object",
        properties: {
          goalType: { type: "string", enum: ["goto_tile"] },
          target: {
            type: "object",
            properties: {
              x: { type: "integer" },
              y: { type: "integer" }
            },
            required: ["x", "y"],
            additionalProperties: false
          },
          targets: {
            type: "array",
            items: {
              type: "object",
              properties: {
                x: { type: "integer" },
                y: { type: "integer" }
              },
              required: ["x", "y"],
              additionalProperties: false
            },
            minItems: 1,
            maxItems: 12
          },
          reason: { type: "string" },
          priority: { type: "string", enum: ["override_once", "sticky_until_done"] },
          expiresTicks: { type: "integer", minimum: 1, maximum: 300 }
        },
        required: ["goalType"],
        additionalProperties: false
      }
    }
  };

  const setForbiddenTileTool = {
    type: "function",
    function: {
      name: "set_forbidden_tile",
      description: "Mark a tile as sticky-forbidden so the planner treats it as unwalkable.",
      parameters: {
        type: "object",
        properties: {
          goalType: { type: "string", enum: ["forbid_tile"] },
          target: {
            type: "object",
            properties: {
              x: { type: "integer" },
              y: { type: "integer" }
            },
            required: ["x", "y"],
            additionalProperties: false
          },
          reason: { type: "string" }
        },
        required: ["goalType", "target"],
        additionalProperties: false
      }
    }
  };

  const removeForbiddenTileTool = {
    type: "function",
    function: {
      name: "remove_forbidden_tile",
      description: "Remove a previously forbidden tile.",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "object",
            properties: {
              x: { type: "integer" },
              y: { type: "integer" }
            },
            required: ["x", "y"],
            additionalProperties: false
          }
        },
        required: ["target"],
        additionalProperties: false
      }
    }
  };

  const setPickupTileMultiplierTool = {
    type: "function",
    function: {
      name: "set_pickup_tile_multiplier",
      description: "Set a sticky reward multiplier for packages picked up from a tile.",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "object",
            properties: { x: { type: "integer" }, y: { type: "integer" } },
            required: ["x", "y"],
            additionalProperties: false
          },
          multiplier: { type: "number", exclusiveMinimum: 0 },
          reason: { type: "string" }
        },
        required: ["target", "multiplier"],
        additionalProperties: false
      }
    }
  };

  const removePickupTileMultiplierTool = {
    type: "function",
    function: {
      name: "remove_pickup_tile_multiplier",
      description: "Remove a sticky pickup-tile reward multiplier.",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "object",
            properties: { x: { type: "integer" }, y: { type: "integer" } },
            required: ["x", "y"],
            additionalProperties: false
          }
        },
        required: ["target"],
        additionalProperties: false
      }
    }
  };

  const setDeliveryTileMultiplierTool = {
    type: "function",
    function: {
      name: "set_delivery_tile_multiplier",
      description: "Set a sticky reward multiplier for deliveries to a tile.",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "object",
            properties: { x: { type: "integer" }, y: { type: "integer" } },
            required: ["x", "y"],
            additionalProperties: false
          },
          multiplier: { type: "number", exclusiveMinimum: 0 },
          reason: { type: "string" }
        },
        required: ["target", "multiplier"],
        additionalProperties: false
      }
    }
  };

  const removeDeliveryTileMultiplierTool = {
    type: "function",
    function: {
      name: "remove_delivery_tile_multiplier",
      description: "Remove a sticky delivery-tile reward multiplier.",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "object",
            properties: { x: { type: "integer" }, y: { type: "integer" } },
            required: ["x", "y"],
            additionalProperties: false
          }
        },
        required: ["target"],
        additionalProperties: false
      }
    }
  };

  const setDeliveryCountMultiplierTool = {
    type: "function",
    function: {
      name: "set_delivery_count_multiplier",
      description: "Set a sticky reward multiplier for deliveries with an exact package count.",
      parameters: {
        type: "object",
        properties: {
          count: { type: "integer", minimum: 1 },
          multiplier: { type: "number", minimum: 0 },
          reason: { type: "string" }
        },
        required: ["count", "multiplier"],
        additionalProperties: false
      }
    }
  };

  const removeDeliveryCountMultiplierTool = {
    type: "function",
    function: {
      name: "remove_delivery_count_multiplier",
      description: "Remove a sticky delivery-count reward multiplier.",
      parameters: {
        type: "object",
        properties: {
          count: { type: "integer", minimum: 1 }
        },
        required: ["count"],
        additionalProperties: false
      }
    }
  };

  const chatTools = [
    explicitPlanTool,
    setForbiddenTileTool,
    removeForbiddenTileTool,
    setPickupTileMultiplierTool,
    removePickupTileMultiplierTool,
    setDeliveryTileMultiplierTool,
    removeDeliveryTileMultiplierTool,
    setDeliveryCountMultiplierTool,
    removeDeliveryCountMultiplierTool
  ];

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

  async function callModel(messages) {
    const baseURL = process.env.LITELLM_BASE_URL || "https://llm.bears.disi.unitn.it/v1";
    const apiKey = process.env.LITELLM_API_KEY;
    const model = process.env.LOCAL_MODEL || "llama-3.3-70b-lmstudio";

    if (!apiKey && !llmCaller) {
      throw new Error("missing LITELLM_API_KEY in .env file");
    }

    const startedAt = Date.now();

    if (llmCaller) {
      const custom = await llmCaller({
        model,
        messages,
        tools: chatTools,
        toolChoice: "auto",
        temperature: 0
      });
      const message = custom?.message ?? custom?.choices?.[0]?.message ?? custom ?? {};
      const llmLatencyMs = Number(custom?.llmLatencyMs ?? Date.now() - startedAt) || 0;
      return { message, llmLatencyMs };
    }

    if (!chatClient) {
      const { default: OpenAI } = await import("openai");
      chatClient = new OpenAI({ baseURL, apiKey });
      chatModel = model;
    }

    const response = await chatClient.chat.completions.create({
      model: chatModel,
      messages,
      tools: chatTools,
      tool_choice: "auto",
      temperature: 0
    });

    return {
      message: response.choices?.[0]?.message ?? {},
      llmLatencyMs: Date.now() - startedAt
    };
  }

  async function executeToolCall(call, { senderId, sourceChatId }) {
    const toolName = String(call?.function?.name ?? "").trim();
    const rawArgs = call?.function?.arguments;

    if (toolName === "set_explicit_plan") {
      const parsed = parseJsonArguments(rawArgs, "I could not parse your plan request. Please provide a tile like (x,y).");
      if (!parsed.ok) return asToolError(toolName, parsed.error);

      const parsedArgs = parsed.value;
      // LLM latency can be long; refresh logical time so manual-task TTL starts "now".
      if (typeof beliefs.advanceTimeFromClock === "function") {
        beliefs.advanceTimeFromClock();
      }
      const validation = validateExplicitPlanArgs(parsedArgs);
      if (!validation.ok) {
        return asToolError(toolName, `Plan rejected: ${validation.reason}.`, {
          planError: validation.reason,
          toolArgs: parsedArgs
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
          toolArgs: parsedArgs
        }
      );
    }

    if (toolName === "set_forbidden_tile") {
      const parsed = parseJsonArguments(
        rawArgs,
        "I could not parse the forbidden tile request. Please provide a tile like (x,y)."
      );
      if (!parsed.ok) return asToolError(toolName, parsed.error);

      const parsedArgs = parsed.value;
      const validation = validateForbiddenTileArgs(parsedArgs, { allowCurrentTile: true });
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
          toolArgs: parsedArgs
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
            toolArgs: parsedArgs
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
        toolArgs: parsedArgs
      });
    }

    if (toolName === "remove_forbidden_tile") {
      const parsed = parseJsonArguments(rawArgs, "I could not parse the removal request. Please provide a tile like (x,y).");
      if (!parsed.ok) return asToolError(toolName, parsed.error);

      const parsedArgs = parsed.value;
      const validation = validateForbiddenTileArgs(parsedArgs, { allowCurrentTile: true });
      if (!validation.ok) {
        return asToolError(toolName, `Forbidden-tile removal rejected: ${validation.reason}.`, {
          toolArgs: parsedArgs
        });
      }
      const removed = beliefs.removeForbiddenTile(validation.value.target, {
        sourceChatId: Number(sourceChatId ?? 0) || null,
        senderId
      });
      if (!removed) {
        return asToolError(
          toolName,
          `Tile (${validation.value.target.x},${validation.value.target.y}) was not in the forbidden set.`,
          { toolArgs: parsedArgs }
        );
      }
      logger.info("forbidden tile removed", {
        senderId,
        chatId: sourceChatId,
        tile: validation.value.target
      });
      return asToolSuccess(
        toolName,
        `Forbidden tile removed at (${validation.value.target.x},${validation.value.target.y}).`,
        {
          removedForbiddenTile: removed,
          toolArgs: parsedArgs
        }
      );
    }

    if (toolName === "set_pickup_tile_multiplier") {
      const parsed = parseJsonArguments(rawArgs, "I could not parse pickup multiplier request. Please include tile and multiplier.");
      if (!parsed.ok) return asToolError(toolName, parsed.error);
      const parsedArgs = parsed.value;
      const validation = validateMultiplierArgs(parsedArgs);
      if (!validation.ok) return asToolError(toolName, `Pickup multiplier rejected: ${validation.reason}.`, { toolArgs: parsedArgs });
      const entry = beliefs.setPickupTileMultiplier(validation.value.target, validation.value.multiplier, {
        reason: validation.value.reason,
        sourceChatId: Number(sourceChatId ?? 0) || null,
        senderId
      });
      if (!entry) return asToolError(toolName, "Pickup multiplier rejected: invalid_multiplier.", { toolArgs: parsedArgs });
      return asToolSuccess(toolName, `Pickup multiplier set at (${entry.x},${entry.y}) to ${entry.multiplier}x.`, {
        pickupMultiplierRule: entry,
        toolArgs: parsedArgs
      });
    }

    if (toolName === "remove_pickup_tile_multiplier") {
      const parsed = parseJsonArguments(rawArgs, "I could not parse pickup multiplier removal request.");
      if (!parsed.ok) return asToolError(toolName, parsed.error);
      const parsedArgs = parsed.value;
      const target = parseTarget(parsedArgs);
      if (!target) return asToolError(toolName, "Pickup multiplier removal rejected: invalid_coordinates.", { toolArgs: parsedArgs });
      const removed = beliefs.removePickupTileMultiplier(target, {
        sourceChatId: Number(sourceChatId ?? 0) || null,
        senderId
      });
      if (!removed) return asToolError(toolName, `No pickup multiplier rule found at (${target.x},${target.y}).`, { toolArgs: parsedArgs });
      return asToolSuccess(toolName, `Pickup multiplier removed at (${target.x},${target.y}).`, {
        toolArgs: parsedArgs
      });
    }

    if (toolName === "set_delivery_tile_multiplier") {
      const parsed = parseJsonArguments(rawArgs, "I could not parse delivery multiplier request. Please include tile and multiplier.");
      if (!parsed.ok) return asToolError(toolName, parsed.error);
      const parsedArgs = parsed.value;
      const validation = validateMultiplierArgs(parsedArgs);
      if (!validation.ok) return asToolError(toolName, `Delivery multiplier rejected: ${validation.reason}.`, { toolArgs: parsedArgs });
      const entry = beliefs.setDeliveryTileMultiplier(validation.value.target, validation.value.multiplier, {
        reason: validation.value.reason,
        sourceChatId: Number(sourceChatId ?? 0) || null,
        senderId
      });
      if (!entry) return asToolError(toolName, "Delivery multiplier rejected: invalid_multiplier.", { toolArgs: parsedArgs });
      return asToolSuccess(toolName, `Delivery multiplier set at (${entry.x},${entry.y}) to ${entry.multiplier}x.`, {
        deliveryMultiplierRule: entry,
        toolArgs: parsedArgs
      });
    }

    if (toolName === "remove_delivery_tile_multiplier") {
      const parsed = parseJsonArguments(rawArgs, "I could not parse delivery multiplier removal request.");
      if (!parsed.ok) return asToolError(toolName, parsed.error);
      const parsedArgs = parsed.value;
      const target = parseTarget(parsedArgs);
      if (!target) return asToolError(toolName, "Delivery multiplier removal rejected: invalid_coordinates.", { toolArgs: parsedArgs });
      const removed = beliefs.removeDeliveryTileMultiplier(target, {
        sourceChatId: Number(sourceChatId ?? 0) || null,
        senderId
      });
      if (!removed) return asToolError(toolName, `No delivery multiplier rule found at (${target.x},${target.y}).`, { toolArgs: parsedArgs });
      return asToolSuccess(toolName, `Delivery multiplier removed at (${target.x},${target.y}).`, {
        toolArgs: parsedArgs
      });
    }

    if (toolName === "set_delivery_count_multiplier") {
      const parsed = parseJsonArguments(
        rawArgs,
        "I could not parse delivery count multiplier request. Please include count and multiplier."
      );
      if (!parsed.ok) return asToolError(toolName, parsed.error);
      const parsedArgs = parsed.value;
      const validation = validateDeliveryCountMultiplierArgs(parsedArgs);
      if (!validation.ok) return asToolError(toolName, `Delivery count multiplier rejected: ${validation.reason}.`, {
        toolArgs: parsedArgs
      });
      const entry = beliefs.setDeliveryCountMultiplier(validation.value.count, validation.value.multiplier, {
        reason: validation.value.reason,
        sourceChatId: Number(sourceChatId ?? 0) || null,
        senderId
      });
      if (!entry) return asToolError(toolName, "Delivery count multiplier rejected: invalid_payload.", { toolArgs: parsedArgs });
      return asToolSuccess(
        toolName,
        `Delivery count multiplier set for ${entry.count} package(s) to ${entry.multiplier}x.`,
        {
          deliveryCountMultiplierRule: entry,
          toolArgs: parsedArgs
        }
      );
    }

    if (toolName === "remove_delivery_count_multiplier") {
      const parsed = parseJsonArguments(rawArgs, "I could not parse delivery count multiplier removal request.");
      if (!parsed.ok) return asToolError(toolName, parsed.error);
      const parsedArgs = parsed.value;
      const count = parsePositiveIntegerCount(parsedArgs);
      if (count === null) return asToolError(toolName, "Delivery count multiplier removal rejected: invalid_count.", { toolArgs: parsedArgs });
      const removed = beliefs.removeDeliveryCountMultiplier(count, {
        sourceChatId: Number(sourceChatId ?? 0) || null,
        senderId
      });
      if (!removed) return asToolError(toolName, `No delivery count multiplier rule found for count ${count}.`, { toolArgs: parsedArgs });
      return asToolSuccess(toolName, `Delivery count multiplier removed for count ${count}.`, {
        toolArgs: parsedArgs
      });
    }

    return asToolError(
      toolName || "unknown_tool",
      `Unknown tool '${toolName}'. Available tools: ${chatTools.map((tool) => tool.function.name).join(", ")}.`
    );
  }

  async function evaluateChatPrompt(messages, senderId, sourceChatId) {
    const turnMessages = [...messages];
    const toolOutcomes = [];
    const llmLatencies = [];
    const toolSequence = [];

    let responseText = "";
    let stopReason = "max_iterations";

    for (let iteration = 0; iteration < maxToolIterations; iteration += 1) {
      const { message, llmLatencyMs } = await callModel(turnMessages);
      llmLatencies.push(Number(llmLatencyMs) || 0);

      const rawToolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
      const toolCalls = rawToolCalls.map((call, index) => ({
        ...call,
        id: String(call?.id ?? `tool_call_${iteration}_${index}`),
        function: {
          ...call?.function
        }
      }));

      const assistantMessage = {
        role: "assistant",
        content: typeof message?.content === "string" ? message.content : "",
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined
      };
      turnMessages.push(assistantMessage);
      if (toolCalls.length === 0) {
        responseText = String(message?.content ?? "").trim();
        stopReason = "final_response";
        break;
      }

      for (const [index, call] of toolCalls.entries()) {
        if (toolOutcomes.length >= maxTotalToolCalls) {
          stopReason = "max_tool_calls";
          break;
        }

        const toolName = String(call?.function?.name ?? "").trim();
        const outcome = await executeToolCall(call, { senderId, sourceChatId });
        toolOutcomes.push(outcome);
        toolSequence.push({
          name: toolName || "unknown",
          ok: Boolean(outcome.ok)
        });

        const toolCallId = String(call?.id ?? `tool_call_${iteration}_${index}`);
        turnMessages.push({
          role: "tool",
          tool_call_id: toolCallId,
          name: toolName || "unknown_tool",
          content: JSON.stringify({
            ok: outcome.ok,
            tool: outcome.toolName,
            message: outcome.message,
            data: {
              planId: outcome?.plan?.id ?? null,
              toolArgs: compactToolArgs(outcome?.toolArgs ?? null)
            }
          })
        });
      }

      if (stopReason === "max_tool_calls") {
        break;
      }
    }

    const hadErrors = toolOutcomes.some((entry) => !entry.ok);
    const firstTool = toolOutcomes[0] ?? null;
    const llmLatencyMsTotal = llmLatencies.reduce((acc, value) => acc + (Number(value) || 0), 0);

    if (!responseText) {
      responseText = stopReason === "max_tool_calls" || stopReason === "max_iterations"
        ? buildLimitFallback(toolOutcomes, stopReason)
        : "I could not produce a valid response.";
    }

    const mixedSummary = buildMixedSummary(toolOutcomes);
    if (mixedSummary) {
      responseText = responseText ? `${responseText}\n${mixedSummary}` : mixedSummary;
    }

    return {
      response: responseText,
      plan: toolOutcomes.find((entry) => entry.plan)?.plan ?? null,
      plans: toolOutcomes.flatMap((entry) => (Array.isArray(entry.plans) ? entry.plans : [])),
      meta: {
        toolName: firstTool?.toolName ?? null,
        toolArgs: firstTool?.toolArgs ?? null,
        fallbackKind: stopReason === "final_response" ? null : stopReason,
        llmLatencyMs: llmLatencies.length > 0 ? llmLatencies[0] : null,
        llmLatencyMsTotal,
        llmCalls: llmLatencies.length,
        toolCalls: toolOutcomes.length,
        toolSequence,
        hadErrors,
        stopReason
      }
    };
  }

  async function processPendingChatMessage() {
    const [message] = beliefs.pendingChatMessages?.(lastEvaluatedChatId, 1) ?? [];
    if (!message) return false;
    const startedAt = Date.now();

    const senderId = message.fromId ?? message.id ?? message.from ?? null;
    if (senderId && beliefs.me?.id && senderId === beliefs.me.id) {
      lastEvaluatedChatId = Number(message.chatId ?? lastEvaluatedChatId);
      return true;
    }

    const prompt = [
      {
        role: "system",
        content: [
          "You are a Deliveroo chat agent inside a BDI loop.",
          "For actionable map/planner/task instructions, you MUST use matching tool calls and not plain JSON text.",
          "You may call multiple tools sequentially when needed to complete a single user instruction.",
          "If a tool call fails, continue if additional tool calls can still make progress, then return a concise final status.",
          "Tool mapping:",
          "- set_explicit_plan: explicit movement tasks like go to tile (x,y), optionally as a sequence with targets=[{x,y},...].",
          "- set_forbidden_tile / remove_forbidden_tile: add/remove sticky forbidden tiles.",
          "- set_pickup_tile_multiplier / remove_pickup_tile_multiplier: add/remove pickup reward multipliers.",
          "- set_delivery_tile_multiplier / remove_delivery_tile_multiplier: add/remove delivery reward multipliers.",
          "- set_delivery_count_multiplier / remove_delivery_count_multiplier: add/remove delivery reward multipliers by exact delivered package count.",
          "If the message is not an actionable instruction, reply briefly in plain text.",
          "Never output a raw JSON object in assistant text when a tool should be used."
        ].join("\n")
      },
      {
        role: "user",
        content: `Incoming chat message: ${JSON.stringify(message)}`
      }
    ];

    try {
      const evaluated = await evaluateChatPrompt(prompt, senderId, message.chatId);
      const response = String(evaluated?.response ?? "").trim();
      const totalLatencyMs = Date.now() - startedAt;
      if (response && senderId) {
        const status = await executor.writeMessage({
          toId: senderId,
          message: response
        });
        logger.info("chat evaluated and replied", {
          chatId: message.chatId,
          senderId,
          status,
          response,
          manualTaskId: evaluated?.plan?.id ?? null
        });
        await writeChatDiagnostics({
          event: "chat_processed",
          chatId: Number(message.chatId ?? 0) || null,
          senderId,
          incomingMessage: String(message?.content ?? message?.text ?? "").slice(0, 400),
          response: response.slice(0, 600),
          toolName: evaluated?.meta?.toolName ?? null,
          toolArgs: evaluated?.meta?.toolArgs ?? null,
          fallbackKind: evaluated?.meta?.fallbackKind ?? null,
          llmLatencyMs: Number(evaluated?.meta?.llmLatencyMs ?? 0) || null,
          llmLatencyMsTotal: Number(evaluated?.meta?.llmLatencyMsTotal ?? 0) || null,
          llmCalls: Number(evaluated?.meta?.llmCalls ?? 0) || 0,
          toolCalls: Number(evaluated?.meta?.toolCalls ?? 0) || 0,
          toolSequence: Array.isArray(evaluated?.meta?.toolSequence) ? evaluated.meta.toolSequence : [],
          hadErrors: Boolean(evaluated?.meta?.hadErrors),
          stopReason: evaluated?.meta?.stopReason ?? null,
          totalLatencyMs,
          writeStatus: status
        });
      } else {
        logger.warn("chat evaluated with empty response", {
          chatId: message.chatId,
          senderId
        });
        await writeChatDiagnostics({
          event: "chat_empty_response",
          chatId: Number(message.chatId ?? 0) || null,
          senderId,
          incomingMessage: String(message?.content ?? message?.text ?? "").slice(0, 400),
          toolName: evaluated?.meta?.toolName ?? null,
          llmLatencyMs: Number(evaluated?.meta?.llmLatencyMs ?? 0) || null,
          llmLatencyMsTotal: Number(evaluated?.meta?.llmLatencyMsTotal ?? 0) || null,
          llmCalls: Number(evaluated?.meta?.llmCalls ?? 0) || 0,
          toolCalls: Number(evaluated?.meta?.toolCalls ?? 0) || 0,
          toolSequence: Array.isArray(evaluated?.meta?.toolSequence) ? evaluated.meta.toolSequence : [],
          hadErrors: Boolean(evaluated?.meta?.hadErrors),
          stopReason: evaluated?.meta?.stopReason ?? null,
          totalLatencyMs
        });
      }
    } catch (error) {
      logger.error("chat evaluation failed", {
        chatId: message.chatId,
        senderId,
        error: error.message
      });
      await writeChatDiagnostics({
        event: "chat_failed",
        chatId: Number(message.chatId ?? 0) || null,
        senderId,
        incomingMessage: String(message?.content ?? message?.text ?? "").slice(0, 400),
        totalLatencyMs: Date.now() - startedAt,
        error: error.message
      });
    } finally {
      lastEvaluatedChatId = Number(message.chatId ?? lastEvaluatedChatId);
    }

    return true;
  }

  return {
    processPendingChatMessage
  };
}
