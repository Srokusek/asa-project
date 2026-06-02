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
  return [
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
