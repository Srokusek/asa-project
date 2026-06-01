import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export function createChatProcessor({ beliefs, executor, logger }) {
  let lastEvaluatedChatId = 0;
  let chatClient = null;
  let chatModel = null;
  let chatLogReady = false;
  const chatDiagnosticsEnabled = process.env.CHAT_DIAGNOSTICS_ENABLED !== "0";
  const chatDiagnosticsFile = resolve(process.env.CHAT_DIAGNOSTICS_FILE || "logs/chat-diagnostics.jsonl");

  async function writeChatDiagnostics(entry) {
    if (!chatDiagnosticsEnabled) return;
    try {
      if (!chatLogReady) {
        await mkdir(dirname(chatDiagnosticsFile), { recursive: true });
        chatLogReady = true;
      }
      await appendFile(chatDiagnosticsFile, `${JSON.stringify({
        ts: new Date().toISOString(),
        ...entry
      })}\n`, "utf8");
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
    const targetInputs = Array.isArray(args.targets) && args.targets.length > 0
      ? args.targets.map((target) => ({ target }))
      : (args.target ? [{ target: args.target }] : []);
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

  async function evaluateChatPrompt(messages, senderId, sourceChatId) {
    const baseURL = process.env.LITELLM_BASE_URL || "https://llm.bears.disi.unitn.it/v1";
    const apiKey = process.env.LITELLM_API_KEY;
    const model = process.env.LOCAL_MODEL || "llama-3.3-70b-lmstudio";

    if (!apiKey) {
      throw new Error("missing LITELLM_API_KEY in .env file");
    }

    if (!chatClient) {
      const { default: OpenAI } = await import("openai");
      chatClient = new OpenAI({ baseURL, apiKey });
      chatModel = model;
    }

    const llmStartedAt = Date.now();
    const response = await chatClient.chat.completions.create({
      model: chatModel,
      messages,
      tools: [
        explicitPlanTool,
        setForbiddenTileTool,
        removeForbiddenTileTool,
        setPickupTileMultiplierTool,
        removePickupTileMultiplierTool,
        setDeliveryTileMultiplierTool,
        removeDeliveryTileMultiplierTool,
        setDeliveryCountMultiplierTool,
        removeDeliveryCountMultiplierTool
      ],
      tool_choice: "auto",
      temperature: 0
    });
    const llmLatencyMs = Date.now() - llmStartedAt;

    const message = response.choices?.[0]?.message ?? {};
    const call = message.tool_calls?.[0];
    if (call?.function?.name === "set_explicit_plan") {
      let parsedArgs = null;
      try {
        parsedArgs = JSON.parse(call.function?.arguments ?? "{}");
      } catch (_error) {
        return { response: "I could not parse your plan request. Please provide a tile like (x,y)." };
      }
      const validation = validateExplicitPlanArgs(parsedArgs);
      if (!validation.ok) {
        return {
          response: `Plan rejected: ${validation.reason}.`,
          planError: validation.reason
        };
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

      return {
        response: plans.length === 1
          ? `Plan accepted: moving to (${plans[0].payload.target.x},${plans[0].payload.target.y}).`
          : `Plan accepted: queued ${plans.length} steps (${plans.map((plan) => `(${plan.payload.target.x},${plan.payload.target.y})`).join(" -> ")}).`,
        plan: plans[0] ?? null,
        plans,
        meta: { toolName: "set_explicit_plan", llmLatencyMs, toolArgs: parsedArgs }
      };
    }

    if (call?.function?.name === "set_forbidden_tile") {
      let parsedArgs = null;
      try {
        parsedArgs = JSON.parse(call.function?.arguments ?? "{}");
      } catch (_error) {
        return { response: "I could not parse the forbidden tile request. Please provide a tile like (x,y)." };
      }

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
        return { response: `Forbidden-tile instruction rejected: ${validation.reason}.` };
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
          return { response: "Forbidden-tile instruction rejected: cannot_leave_tile_before_forbid." };
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
      return {
        response: `Forbidden tile set at (${created.x},${created.y}). I will avoid it.`,
        forbiddenTile: created,
        meta: { toolName: "set_forbidden_tile", llmLatencyMs, toolArgs: parsedArgs }
      };
    }

    if (call?.function?.name === "remove_forbidden_tile") {
      let parsedArgs = null;
      try {
        parsedArgs = JSON.parse(call.function?.arguments ?? "{}");
      } catch (_error) {
        return { response: "I could not parse the removal request. Please provide a tile like (x,y)." };
      }
      const validation = validateForbiddenTileArgs(parsedArgs, { allowCurrentTile: true });
      if (!validation.ok) {
        return { response: `Forbidden-tile removal rejected: ${validation.reason}.` };
      }
      const removed = beliefs.removeForbiddenTile(validation.value.target, {
        sourceChatId: Number(sourceChatId ?? 0) || null,
        senderId
      });
      if (!removed) {
        return {
          response: `Tile (${validation.value.target.x},${validation.value.target.y}) was not in the forbidden set.`
        };
      }
      logger.info("forbidden tile removed", {
        senderId,
        chatId: sourceChatId,
        tile: validation.value.target
      });
      return {
        response: `Forbidden tile removed at (${validation.value.target.x},${validation.value.target.y}).`,
        removedForbiddenTile: removed,
        meta: { toolName: "remove_forbidden_tile", llmLatencyMs, toolArgs: parsedArgs }
      };
    }

    if (call?.function?.name === "set_pickup_tile_multiplier") {
      let parsedArgs = null;
      try {
        parsedArgs = JSON.parse(call.function?.arguments ?? "{}");
      } catch (_error) {
        return { response: "I could not parse pickup multiplier request. Please include tile and multiplier." };
      }
      const validation = validateMultiplierArgs(parsedArgs);
      if (!validation.ok) return { response: `Pickup multiplier rejected: ${validation.reason}.` };
      const entry = beliefs.setPickupTileMultiplier(
        validation.value.target,
        validation.value.multiplier,
        {
          reason: validation.value.reason,
          sourceChatId: Number(sourceChatId ?? 0) || null,
          senderId
        }
      );
      if (!entry) return { response: "Pickup multiplier rejected: invalid_multiplier." };
      return {
        response: `Pickup multiplier set at (${entry.x},${entry.y}) to ${entry.multiplier}x.`,
        pickupMultiplierRule: entry,
        meta: { toolName: "set_pickup_tile_multiplier", llmLatencyMs, toolArgs: parsedArgs }
      };
    }

    if (call?.function?.name === "remove_pickup_tile_multiplier") {
      let parsedArgs = null;
      try {
        parsedArgs = JSON.parse(call.function?.arguments ?? "{}");
      } catch (_error) {
        return { response: "I could not parse pickup multiplier removal request." };
      }
      const target = parseTarget(parsedArgs);
      if (!target) return { response: "Pickup multiplier removal rejected: invalid_coordinates." };
      const removed = beliefs.removePickupTileMultiplier(target, {
        sourceChatId: Number(sourceChatId ?? 0) || null,
        senderId
      });
      if (!removed) return { response: `No pickup multiplier rule found at (${target.x},${target.y}).` };
      return {
        response: `Pickup multiplier removed at (${target.x},${target.y}).`,
        meta: { toolName: "remove_pickup_tile_multiplier", llmLatencyMs, toolArgs: parsedArgs }
      };
    }

    if (call?.function?.name === "set_delivery_tile_multiplier") {
      let parsedArgs = null;
      try {
        parsedArgs = JSON.parse(call.function?.arguments ?? "{}");
      } catch (_error) {
        return { response: "I could not parse delivery multiplier request. Please include tile and multiplier." };
      }
      const validation = validateMultiplierArgs(parsedArgs);
      if (!validation.ok) return { response: `Delivery multiplier rejected: ${validation.reason}.` };
      const entry = beliefs.setDeliveryTileMultiplier(
        validation.value.target,
        validation.value.multiplier,
        {
          reason: validation.value.reason,
          sourceChatId: Number(sourceChatId ?? 0) || null,
          senderId
        }
      );
      if (!entry) return { response: "Delivery multiplier rejected: invalid_multiplier." };
      return {
        response: `Delivery multiplier set at (${entry.x},${entry.y}) to ${entry.multiplier}x.`,
        deliveryMultiplierRule: entry,
        meta: { toolName: "set_delivery_tile_multiplier", llmLatencyMs, toolArgs: parsedArgs }
      };
    }

    if (call?.function?.name === "remove_delivery_tile_multiplier") {
      let parsedArgs = null;
      try {
        parsedArgs = JSON.parse(call.function?.arguments ?? "{}");
      } catch (_error) {
        return { response: "I could not parse delivery multiplier removal request." };
      }
      const target = parseTarget(parsedArgs);
      if (!target) return { response: "Delivery multiplier removal rejected: invalid_coordinates." };
      const removed = beliefs.removeDeliveryTileMultiplier(target, {
        sourceChatId: Number(sourceChatId ?? 0) || null,
        senderId
      });
      if (!removed) return { response: `No delivery multiplier rule found at (${target.x},${target.y}).` };
      return {
        response: `Delivery multiplier removed at (${target.x},${target.y}).`,
        meta: { toolName: "remove_delivery_tile_multiplier", llmLatencyMs, toolArgs: parsedArgs }
      };
    }

    if (call?.function?.name === "set_delivery_count_multiplier") {
      let parsedArgs = null;
      try {
        parsedArgs = JSON.parse(call.function?.arguments ?? "{}");
      } catch (_error) {
        return { response: "I could not parse delivery count multiplier request. Please include count and multiplier." };
      }
      const validation = validateDeliveryCountMultiplierArgs(parsedArgs);
      if (!validation.ok) return { response: `Delivery count multiplier rejected: ${validation.reason}.` };
      const entry = beliefs.setDeliveryCountMultiplier(
        validation.value.count,
        validation.value.multiplier,
        {
          reason: validation.value.reason,
          sourceChatId: Number(sourceChatId ?? 0) || null,
          senderId
        }
      );
      if (!entry) return { response: "Delivery count multiplier rejected: invalid_payload." };
      return {
        response: `Delivery count multiplier set for ${entry.count} package(s) to ${entry.multiplier}x.`,
        deliveryCountMultiplierRule: entry,
        meta: { toolName: "set_delivery_count_multiplier", llmLatencyMs, toolArgs: parsedArgs }
      };
    }

    if (call?.function?.name === "remove_delivery_count_multiplier") {
      let parsedArgs = null;
      try {
        parsedArgs = JSON.parse(call.function?.arguments ?? "{}");
      } catch (_error) {
        return { response: "I could not parse delivery count multiplier removal request." };
      }
      const count = parsePositiveIntegerCount(parsedArgs);
      if (count === null) return { response: "Delivery count multiplier removal rejected: invalid_count." };
      const removed = beliefs.removeDeliveryCountMultiplier(count, {
        sourceChatId: Number(sourceChatId ?? 0) || null,
        senderId
      });
      if (!removed) return { response: `No delivery count multiplier rule found for count ${count}.` };
      return {
        response: `Delivery count multiplier removed for count ${count}.`,
        meta: { toolName: "remove_delivery_count_multiplier", llmLatencyMs, toolArgs: parsedArgs }
      };
    }

    return { response: String(message?.content ?? "").trim() };
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
          "For actionable map/planner/task instructions, you MUST use exactly one matching tool call and not plain JSON text.",
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
