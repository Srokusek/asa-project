import "dotenv/config";
import { pathToFileURL } from "node:url";
import { createCoordinationBDIAgent } from "./agents/llm-coordination-agent.js";
import { createStandardBDIAgent } from "./agents/standard-bdi-agent.js";
import { buildRoleConfig, CONFIG } from "./config.js";
import { createLogger } from "./utils/logger.js";

export function normalizeAgentRole(value = process.env.AGENT_ROLE) {
  const role = String(value ?? "bdi").trim().toLowerCase();
  if (["llm", "coordination", "coordinator"].includes(role)) return "llm";
  return "bdi";
}

export function createAgentForRole(role, config = CONFIG, options = {}) {
  const normalized = normalizeAgentRole(role);
  const roleConfig = config.agentRole === normalized ? config : buildRoleConfig(config, normalized);
  return normalized === "llm"
    ? createCoordinationBDIAgent(roleConfig, options)
    : createStandardBDIAgent(roleConfig, options);
}

export function startAgent({
  role = normalizeAgentRole(),
  config = CONFIG,
  options = {},
  attachSignals = true
} = {}) {
  const normalizedRole = normalizeAgentRole(role);
  const roleConfig = buildRoleConfig(config, normalizedRole);
  const logger = createLogger(roleConfig.logLevel);
  const agent = createAgentForRole(normalizedRole, roleConfig, options);

  logger.info("starting agent", { role: normalizedRole, agentName: agent.config?.agentName ?? roleConfig.agentName });
  agent.start();

  if (attachSignals) {
    const stop = (signal) => {
      logger.warn(`${signal} received, stopping agent`, { role: normalizedRole });
      agent.stop();
      process.exit(0);
    };

    process.once("SIGINT", () => stop("SIGINT"));
    process.once("SIGTERM", () => stop("SIGTERM"));
  }

  return agent;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) startAgent();
