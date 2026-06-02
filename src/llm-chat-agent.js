import "dotenv/config";
import { createLlmCoordinationAgent } from "./agents/llm-coordination-agent.js";
import { CONFIG } from "./config.js";
import { createLogger } from "./utils/logger.js";

const logger = createLogger(CONFIG.logLevel);
const agent = createLlmCoordinationAgent(CONFIG);

logger.info("starting legacy chat:llm entry as LlmCoordinationAgent");
agent.start();

process.on("SIGINT", () => {
  logger.warn("SIGINT received, stopping LlmCoordinationAgent");
  agent.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  logger.warn("SIGTERM received, stopping LlmCoordinationAgent");
  agent.stop();
  process.exit(0);
});
