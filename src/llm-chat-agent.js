import "dotenv/config";
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";
import { AgentLoop } from "./control/agent-loop.js";
import { CONFIG } from "./config.js";
import { stringifyTeamMessage, parseTeamMessage, TEAM_MESSAGE_TYPES } from "./communication/team-protocol.js";
import { createLlmClient } from "./chat/llm-client.js";
import { parseMissionSpecPayload, parseSimpleMissionText } from "./missions/mission-parser.js";
import { BeliefState } from "./state/belief-state.js";
import { registerSdkListeners } from "./state/sdk-adapter.js";
import { createLogger } from "./utils/logger.js";

function normalizeChatArgs(args) {
  if (args.length === 1 && typeof args[0] === "object") {
    const message = args[0];
    return {
      fromId: message.fromId ?? message.id ?? message.from ?? null,
      fromName: message.fromName ?? message.name ?? null,
      text: String(message.text ?? message.msg ?? message.message ?? "")
    };
  }
  if (args.length >= 3) {
    const [fromId, fromName, msg] = args;
    return { fromId, fromName, text: String(msg ?? "") };
  }
  if (args.length === 2) {
    const [fromId, msg] = args;
    return { fromId, text: String(msg ?? "") };
  }
  return { text: String(args[0] ?? "") };
}

async function translateChatToMissionSpec(message, beliefs, logger) {
  const fallback = parseSimpleMissionText(message.text, {
    sourceAgentId: message.fromId,
    createdAtTick: beliefs.time
  });
  if (!process.env.LITELLM_API_KEY) return fallback;

  try {
    const client = createLlmClient();
    const { message: llmMessage } = await client.call([
      {
        role: "system",
        content: [
          "Translate Deliveroo.js coordination chat into one MissionSpec JSON object.",
          "Do not plan moves. Do not output action sequences. Use only macro mission intent, constraints, and rewardModifiers.",
          "If the chat is not actionable, return null."
        ].join("\n")
      },
      { role: "user", content: JSON.stringify(message) }
    ], { toolChoice: "none", temperature: 0 });
    const text = String(llmMessage?.content ?? "").trim();
    const parsed = parseMissionSpecPayload(text, {
      sourceAgentId: message.fromId,
      createdAtTick: beliefs.time
    });
    return parsed ?? fallback;
  } catch (error) {
    logger.warn("LLM mission translation failed", { error: error.message });
    return fallback;
  }
}

const llmConfig = {
  ...CONFIG,
  agentName: process.env.LLM_AGENT_NAME ?? `${CONFIG.agentName}-LLM`
};

const logger = createLogger(llmConfig.logLevel);
const socket = DjsConnect(llmConfig.host, llmConfig.token, llmConfig.agentName);
const beliefs = new BeliefState(llmConfig);
const loop = new AgentLoop(socket, beliefs, llmConfig);
const translatedChatIds = new Set();

registerSdkListeners(socket, beliefs, loop);

socket.on("msg", (...args) => {
  const normalized = normalizeChatArgs(args);
  if (parseTeamMessage(normalized.text)) return;
  if (normalized.fromId && beliefs.me?.id && String(normalized.fromId) === String(beliefs.me.id)) return;

  const key = `${normalized.fromId ?? "unknown"}:${normalized.text}`;
  if (translatedChatIds.has(key)) return;
  translatedChatIds.add(key);
  if (translatedChatIds.size > 100) translatedChatIds.delete(translatedChatIds.values().next().value);

  void translateChatToMissionSpec(normalized, beliefs, logger).then(async (missionSpec) => {
    if (!missionSpec) return;
    beliefs.missionRegistry.addMission(missionSpec);
    const teamMessage = stringifyTeamMessage({
      type: TEAM_MESSAGE_TYPES.MISSION_SPEC,
      from: beliefs.me?.id ?? llmConfig.agentName,
      to: null,
      tick: beliefs.time,
      ttl: 50,
      payload: { missionSpec }
    });
    await socket.emitShout(teamMessage);
  });
});

socket.on("connect", () => {
  logger.info("connected LLM mission agent");
  loop.start();
});

socket.on("disconnect", (reason) => {
  logger.warn("LLM mission agent disconnected", reason);
  loop.stop();
});

if (socket.connected) {
  loop.start();
}

process.on("SIGINT", () => {
  logger.warn("SIGINT received, stopping LLM mission agent");
  loop.stop();
  socket.disconnect();
  process.exit(0);
});

process.on("SIGTERM", () => {
  logger.warn("SIGTERM received, stopping LLM mission agent");
  loop.stop();
  socket.disconnect();
  process.exit(0);
});
