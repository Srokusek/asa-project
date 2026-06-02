import "dotenv/config";
import { createCoordinationBDIAgent } from "./agents/llm-coordination-agent.js";
import { buildRoleConfig, CONFIG } from "./config.js";
import { createLogger } from "./utils/logger.js";

const config = buildRoleConfig(CONFIG, "llm");
const logger = createLogger(config.logLevel);
const agent = createCoordinationBDIAgent(config);

logger.info("starting legacy chat:llm entry as CoordinationBDIAgent");
agent.start();

process.on("SIGINT", () => {
  logger.warn("SIGINT received, stopping CoordinationBDIAgent");
  agent.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  logger.warn("SIGTERM received, stopping CoordinationBDIAgent");
  agent.stop();
  process.exit(0);
});
