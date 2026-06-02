import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createLlmClient } from "../chat/llm-client.js";
import {
  registerDeliveryCountMultiplierMission,
  registerDeliveryTileMultiplierMission,
  registerForbiddenTileMission,
  registerGotoTileMission,
  registerPickupTileMultiplierMission
} from "../missions/mission-tools.js";

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

function evaluateArithmeticExpression(rawExpression) {
  const expression = String(rawExpression ?? "").trim();
  if (!expression) return { ok: false, reason: "empty_expression" };

  // Keep calculator lightweight while allowing only basic arithmetic characters.
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

export function createChatProcessor({ beliefs, executor, logger, llmCaller = null }) {
  let lastEvaluatedChatId = 0;
  let inFlight = false;
  let inFlightPromise = null;
  let chatLogReady = false;
  const chatDiagnosticsEnabled = process.env.CHAT_DIAGNOSTICS_ENABLED !== "0";
  const chatDiagnosticsFile = resolve(process.env.CHAT_DIAGNOSTICS_FILE || "logs/chat-diagnostics.jsonl");
  const maxToolIterations = Math.max(1, Number(process.env.CHAT_MAX_LLM_ITERATIONS ?? 8) || 8);
  const maxTotalToolCalls = Math.max(1, Number(process.env.CHAT_MAX_TOOL_CALLS ?? 16) || 16);
  const maxCalculatorExpressions = Math.max(1, Number(process.env.CHAT_CALCULATOR_MAX_EXPRESSIONS ?? 12) || 12);
  const maxCalculatorExpressionLength = Math.max(8, Number(process.env.CHAT_CALCULATOR_MAX_EXPR_LENGTH ?? 120) || 120);

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

  const calculateExpressionsTool = {
    type: "function",
    function: {
      name: "calculate_expressions",
      description: "Compute arithmetic expressions and return numeric results for subsequent tool calls.",
      parameters: {
        type: "object",
        properties: {
          expressions: {
            type: "object",
            additionalProperties: { type: "string" }
          }
        },
        required: ["expressions"],
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

  const chatTools = [
    calculateExpressionsTool,
    explicitPlanTool,
    setForbiddenTileTool,
    setPickupTileMultiplierTool,
    setDeliveryTileMultiplierTool,
    setDeliveryCountMultiplierTool
  ];
  const llmClient = createLlmClient({ tools: chatTools, llmCaller });

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

  async function callModel(messages) {
    return llmClient.call(messages, { toolChoice: "auto", temperature: 0 });
  }

  async function executeToolCall(call, { senderId, sourceChatId }) {
    const toolName = String(call?.function?.name ?? "").trim();
    const rawArgs = call?.function?.arguments;

    if (toolName === "calculate_expressions") {
      const parsed = parseJsonArguments(rawArgs, "I could not parse calculator input. Please provide an expressions object.");
      if (!parsed.ok) return asToolError(toolName, parsed.error);
      const parsedArgs = parsed.value;
      const validation = validateCalculatorArgs(parsedArgs);
      if (!validation.ok) {
        return asToolError(toolName, `Calculator input rejected: ${validation.reason}.`, {
          toolArgs: parsedArgs,
          data: {
            reason: validation.reason,
            details: validation.details ?? null
          }
        });
      }
      const results = {};
      for (const [key, expression] of Object.entries(validation.value.expressions)) {
        const evaluation = evaluateArithmeticExpression(expression);
        if (!evaluation.ok) {
          return asToolError(toolName, `Calculator failed for '${key}': ${evaluation.reason}.`, {
            toolArgs: parsedArgs,
            data: {
              reason: evaluation.reason,
              key,
              details: evaluation.details ?? null
            }
          });
        }
        results[key] = evaluation.value;
      }

      return asToolSuccess(toolName, `Calculated ${Object.keys(results).join(", ")}.`, {
        toolArgs: parsedArgs,
        data: {
          results,
          expressionCount: Object.keys(results).length
        }
      });
    }

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

      const { missions, plans } = registerGotoTileMission(beliefs, validation.value, {
        sourceChatId: Number(sourceChatId ?? 0) || null,
        senderId
      });

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
          missions,
          toolArgs: parsedArgs,
          data: {
            goalType: validation.value.goalType,
            targets: validation.value.targets,
            planIds: plans.map((plan) => plan.id),
            missionIds: missions.map((mission) => mission.id)
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

      const parsedArgs = parsed.value;
      const validation = validateForbiddenTileArgs(parsedArgs, { allowCurrentTile: false });
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
          toolArgs: parsedArgs,
          data: { reason: validation.reason }
        });
      }

      const { mission, forbiddenTile: created } = registerForbiddenTileMission(beliefs, validation.value, {
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
        mission,
        toolArgs: parsedArgs,
        data: { forbiddenTile: created, missionId: mission.id }
      });
    }

    if (toolName === "set_pickup_tile_multiplier") {
      const parsed = parseJsonArguments(rawArgs, "I could not parse pickup multiplier request. Please include tile and multiplier.");
      if (!parsed.ok) return asToolError(toolName, parsed.error);
      const parsedArgs = parsed.value;
      const validation = validateMultiplierArgs(parsedArgs);
      if (!validation.ok) return asToolError(toolName, `Pickup multiplier rejected: ${validation.reason}.`, {
        toolArgs: parsedArgs,
        data: { reason: validation.reason }
      });
      const { mission, pickupMultiplierRule: entry } = registerPickupTileMultiplierMission(beliefs, validation.value, {
        sourceChatId: Number(sourceChatId ?? 0) || null,
        senderId
      });
      if (!entry) return asToolError(toolName, "Pickup multiplier rejected: invalid_multiplier.", {
        toolArgs: parsedArgs,
        data: { reason: "invalid_multiplier" }
      });
      return asToolSuccess(toolName, `Pickup multiplier set at (${entry.x},${entry.y}) to ${entry.multiplier}x.`, {
        pickupMultiplierRule: entry,
        mission,
        toolArgs: parsedArgs,
        data: { pickupMultiplierRule: entry, missionId: mission.id }
      });
    }

    if (toolName === "set_delivery_tile_multiplier") {
      const parsed = parseJsonArguments(rawArgs, "I could not parse delivery multiplier request. Please include tile and multiplier.");
      if (!parsed.ok) return asToolError(toolName, parsed.error);
      const parsedArgs = parsed.value;
      const validation = validateMultiplierArgs(parsedArgs);
      if (!validation.ok) return asToolError(toolName, `Delivery multiplier rejected: ${validation.reason}.`, {
        toolArgs: parsedArgs,
        data: { reason: validation.reason }
      });
      const { mission, deliveryMultiplierRule: entry } = registerDeliveryTileMultiplierMission(beliefs, validation.value, {
        sourceChatId: Number(sourceChatId ?? 0) || null,
        senderId
      });
      if (!entry) return asToolError(toolName, "Delivery multiplier rejected: invalid_multiplier.", {
        toolArgs: parsedArgs,
        data: { reason: "invalid_multiplier" }
      });
      return asToolSuccess(toolName, `Delivery multiplier set at (${entry.x},${entry.y}) to ${entry.multiplier}x.`, {
        deliveryMultiplierRule: entry,
        mission,
        toolArgs: parsedArgs,
        data: { deliveryMultiplierRule: entry, missionId: mission.id }
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
        toolArgs: parsedArgs,
        data: { reason: validation.reason }
      });
      const { mission, deliveryCountMultiplierRule: entry } = registerDeliveryCountMultiplierMission(beliefs, validation.value, {
        sourceChatId: Number(sourceChatId ?? 0) || null,
        senderId
      });
      if (!entry) return asToolError(toolName, "Delivery count multiplier rejected: invalid_payload.", {
        toolArgs: parsedArgs,
        data: { reason: "invalid_payload" }
      });
      return asToolSuccess(
        toolName,
        `Delivery count multiplier set for ${entry.count} package(s) to ${entry.multiplier}x.`,
        {
          deliveryCountMultiplierRule: entry,
          mission,
          toolArgs: parsedArgs,
          data: { deliveryCountMultiplierRule: entry, missionId: mission.id }
        }
      );
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
              ...(outcome?.data && typeof outcome.data === "object" ? outcome.data : {}),
              planId: outcome?.plan?.id ?? null,
              planIds: Array.isArray(outcome?.plans) ? outcome.plans.map((plan) => plan?.id ?? null) : [],
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
          "If instruction arguments require arithmetic, call calculate_expressions first and then call actionable tools using computed numeric literals.",
          "You may call multiple tools sequentially when needed to complete a single user instruction.",
          "If a tool call fails, continue if additional tool calls can still make progress, then return a concise final status.",
          "Tool mapping:",
          "- calculate_expressions: evaluate arithmetic expressions and return numeric results for later tool calls.",
          "- set_explicit_plan: explicit movement tasks like go to tile (x,y), optionally as a sequence with targets=[{x,y},...].",
          "- set_forbidden_tile: add sticky forbidden tiles.",
          "- set_pickup_tile_multiplier: add pickup reward multipliers.",
          "- set_delivery_tile_multiplier: add delivery reward multipliers.",
          "- set_delivery_count_multiplier: add delivery reward multipliers by exact delivered package count.",
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

  function kick() {
    if (inFlight) return false;
    const [message] = beliefs.pendingChatMessages?.(lastEvaluatedChatId, 1) ?? [];
    if (!message) return false;
    inFlight = true;
    inFlightPromise = processPendingChatMessage()
      .catch((error) => {
        logger.error("chat kick failed", { error: error.message });
      })
      .finally(() => {
        inFlight = false;
        inFlightPromise = null;
      });
    return true;
  }

  return {
    kick,
    processPendingChatMessage,
    processPendingChatMessageNonBlocking: kick,
    isInFlight: () => inFlight,
    inFlightPromise: () => inFlightPromise
  };
}
