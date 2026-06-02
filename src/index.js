import "dotenv/config";
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";
import { AgentLoop } from "./control/agent-loop.js";
import { createConfig } from "./config.js";
import { BeliefState } from "./state/belief-state.js";
import { registerSdkListeners } from "./state/sdk-adapter.js";
import { createLogger } from "./utils/logger.js";

const config = createConfig();
const logger = createLogger(config.logLevel);

if (config.llm.enabled && !config.llm.chatEnabled) {
  logger.warn("AGENT_TYPE=llm but ADMIN_ID is missing; chat is disabled and the BDI loop will continue without LLM");
}

const socket = DjsConnect(config.host, config.token, config.agentName);
const beliefs = new BeliefState(config);
const loop = new AgentLoop(socket, beliefs, config);

registerSdkListeners(socket, beliefs, config);

socket.on("connect", () => {
  logger.info("connected to Deliveroo.js cloud");
  loop.start();
});

socket.on("disconnect", (reason) => {
  logger.warn("disconnected", reason);
  loop.stop();
});

if (socket.connected) {
  loop.start();
}

process.on("SIGINT", () => {
  logger.warn("SIGINT received, stopping agent");
  loop.stop();
  socket.disconnect();
  process.exit(0);
});

process.on("SIGTERM", () => {
  logger.warn("SIGTERM received, stopping agent");
  loop.stop();
  socket.disconnect();
  process.exit(0);
});
