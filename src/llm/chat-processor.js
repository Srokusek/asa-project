import { createChatDiagnostics } from "./diagnostics.js";
import { createModelClient } from "./model-client.js";
import { chatTools } from "./tool-definitions.js";
import { compactToolArgs, createToolExecutor } from "./tool-executor.js";

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

function buildPrompt(message) {
  const incomingText = String(message?.content ?? message?.text ?? "").trim();
  return [
    {
      role: "system",
      content: [
        "You are the Deliveroo admin chat agent for a BDI-controlled courier.",
        "The BDI loop, planner, and executor are the real control system. You only interpret admin chat and apply manual overrides through tools.",
        "Do not pretend you directly moved the agent, changed the map, or completed execution. Tools queue or apply planner-facing state; the main loop executes later.",
        "Primary rule: if the admin message requests an actionable planner/task/map change, you MUST use the matching tool call(s), not plain text and not raw JSON in assistant text.",
        "Output contract for actionable requests: emit a real tool call in assistant.tool_calls, usually with empty assistant content. Do not serialize a tool call into assistant content.",
        "The runtime only executes entries in tool_calls. Any JSON object, markdown block, or pseudo-function payload written in assistant content is plain text and will not be executed.",
        "If you are about to answer with keys like type, name, function, parameters, or arguments inside assistant text, stop and emit a tool call instead.",
        "Use numeric literals for numeric tool arguments. Do not quote numbers like \"1000\" when the schema expects 1000.",
        "Use only the provided tools. Do not invent tool names, arguments, coordinates, constraints, map facts, or execution results.",
        "If a request refers to relative tiles like leftmost, rightmost, topmost, or bottommost, use a selector in the tool call. Do not invent coordinates.",
        "If arithmetic is needed to produce tool arguments, call calculate_expressions first, then pass computed numeric literals into later tool calls.",
        "You may call multiple tools sequentially when one instruction contains several requested changes.",
        "If one tool call fails, continue with any remaining tool calls that can still make valid progress, then report a concise final status.",
        "If the request is ambiguous, underspecified, contradictory, or asks for unsupported capabilities, do not guess. Ask a short clarification question or state the limitation plainly.",
        "If the admin message is just a general question or conversation unrelated to the agent, the map, planning, tasks, rewards, or Deliveroo state, answer it directly in plain text without using any tool.",
        "Keep final replies brief and operational. Prefer wording like 'queued', 'applied', 'rejected', or 'need clarification' over verbose explanations.",
        "Tool mapping:",
        "- calculate_expressions: evaluate arithmetic expressions and return numeric results for later tool calls.",
        "- set_explicit_plan: create explicit goto_tile manual tasks, optionally as a sequence with targets=[{x,y},...] or with a selector for one relative tile.",
        "- set_forbidden_tile: add sticky forbidden tiles, optionally using a selector for one relative tile.",
        "- set_pickup_tile_multiplier: add sticky pickup reward multipliers. For relative pickup instructions like 'rightmost pickup tile' or 'leftmost pickup tile', use selector with scope='pickup' instead of coordinates.",
        "- set_pickup_tile_bonus: add sticky pickup reward bonuses. For relative pickup instructions like 'topmost pickup tile' or 'bottommost pickup tile', use selector with scope='pickup' instead of coordinates.",
        "- set_delivery_tile_multiplier: add sticky delivery reward multipliers. For relative delivery instructions like 'leftmost delivery tile' or 'rightmost delivery tile', use selector with scope='delivery' instead of coordinates.",
        "- set_delivery_tile_bonus: add sticky delivery reward bonuses. For relative delivery instructions like 'topmost delivery tile' or 'bottommost delivery tile', use selector with scope='delivery' instead of coordinates.",
        "- set_delivery_count_multiplier: add sticky delivery reward multipliers by exact delivered package count.",
        "- set_delivery_count_bonus: add sticky delivery reward bonuses by exact delivered package count.",
        "Non-actionable chat, acknowledgements, and unrelated questions should be answered briefly in plain text.",
        "Never output a raw JSON object, fake function call, or pseudo-tool payload in assistant text when a tool should be used."
      ].join("\n")
    },
    {
      role: "user",
      content: "pickups from the rightmost tile give 1000x points"
    },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "example_pickup_rightmost_multiplier",
          type: "function",
          function: {
            name: "set_pickup_tile_multiplier",
            arguments: JSON.stringify({
              selector: { extreme: "rightmost", scope: "pickup" },
              multiplier: 1000,
              reason: "admin request"
            })
          }
        }
      ]
    },
    {
      role: "tool",
      tool_call_id: "example_pickup_rightmost_multiplier",
      name: "set_pickup_tile_multiplier",
      content: JSON.stringify({
        ok: true,
        tool: "set_pickup_tile_multiplier",
        message: "Applied pickup tile multiplier 1000 to the resolved tile.",
        data: {
          target: { x: 7, y: 4 },
          selector: { extreme: "rightmost", scope: "pickup" }
        }
      })
    },
    {
      role: "assistant",
      content: "Applied pickup multiplier 1000 to the resolved rightmost pickup tile."
    },
    {
      role: "user",
      content: "deliveries to the leftmost tile give 5 bonus points"
    },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "example_delivery_leftmost_bonus",
          type: "function",
          function: {
            name: "set_delivery_tile_bonus",
            arguments: JSON.stringify({
              selector: { extreme: "leftmost", scope: "delivery" },
              bonus: 5,
              reason: "admin request"
            })
          }
        }
      ]
    },
    {
      role: "tool",
      tool_call_id: "example_delivery_leftmost_bonus",
      name: "set_delivery_tile_bonus",
      content: JSON.stringify({
        ok: true,
        tool: "set_delivery_tile_bonus",
        message: "Applied delivery tile bonus 5 to the resolved tile.",
        data: {
          target: { x: 1, y: 6 },
          selector: { extreme: "leftmost", scope: "delivery" }
        }
      })
    },
    {
      role: "assistant",
      content: "Applied delivery bonus 5 to the resolved leftmost delivery tile."
    },
    {
      role: "user",
      content: "what is the capital of france?"
    },
    {
      role: "assistant",
      content: "Paris."
    },
    {
      role: "user",
      content: [
        `Incoming chat message text: ${JSON.stringify(incomingText)}`,
        `Incoming chat envelope: ${JSON.stringify(message)}`
      ].join("\n")
    }
  ];
}

export function createChatProcessor({ beliefs, executor, logger, config, llmCaller = null }) {
  let lastEvaluatedChatId = 0;
  const llmConfig = config?.llm ?? {};
  const maxToolIterations = Math.max(1, Number(llmConfig.maxToolIterations ?? 8) || 8);
  const maxTotalToolCalls = Math.max(1, Number(llmConfig.maxTotalToolCalls ?? 16) || 16);
  const writeChatDiagnostics = createChatDiagnostics({ logger, config });
  const { callModel } = createModelClient({ config, llmCaller, tools: chatTools });
  const { executeToolCall } = createToolExecutor({ beliefs, executor, logger, config });

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

      turnMessages.push({
        role: "assistant",
        content: typeof message?.content === "string" ? message.content : "",
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined
      });

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

        turnMessages.push({
          role: "tool",
          tool_call_id: String(call?.id ?? `tool_call_${iteration}_${index}`),
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
        hadErrors: toolOutcomes.some((entry) => !entry.ok),
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

    try {
      const evaluated = await evaluateChatPrompt(buildPrompt(message), senderId, message.chatId);
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
