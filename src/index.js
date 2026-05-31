import "dotenv/config";
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";
import { AgentLoop } from "./control/agent-loop.js";
import { CONFIG } from "./config.js";
import { BeliefState } from "./state/belief-state.js";
import { registerSdkListeners } from "./state/sdk-adapter.js";
import { createLogger } from "./utils/logger.js";

const logger = createLogger(CONFIG.logLevel);
const socket = DjsConnect(CONFIG.host, CONFIG.token, CONFIG.agentName);
const beliefs = new BeliefState(CONFIG);
const loop = new AgentLoop(socket, beliefs, CONFIG);

registerSdkListeners(socket, beliefs, loop);

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
