function numberFromEnv(env, name, fallback) {
  const value = Number(env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function booleanFromEnv(env, name, fallback = false) {
  const value = env[name];
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function stringFromEnv(env, name, fallback = "") {
  const value = env[name];
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function normalizeHost(host) {
  const raw = String(host || "deliveroojs.azurewebsites.net").trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  return `http://${raw}`;
}

function asFinite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function requiredAgentType(env) {
  const value = String(env.AGENT_TYPE ?? "").trim().toLowerCase();
  if (!value) {
    throw new Error("missing required AGENT_TYPE env var (expected 'bdi' or 'llm')");
  }
  if (value !== "bdi" && value !== "llm") {
    throw new Error(`invalid AGENT_TYPE '${value}' (expected 'bdi' or 'llm')`);
  }
  return value;
}

export const DEFAULT_PLANNER_CONFIG = Object.freeze({
  // Parcel scoring and competition.
  meanPackageValue: 10,
  decayRate: 0.05,
  kWin: 1,
  ignoreEnemyEta: false,
  moveWeight: 1,
  betaCarry: 0.5,
  minParcelConfidence: 0.3,
  enemySafetyMargin: 0,

  // Belief aging and world-state timing.
  periodicReplanTicks: 50,
  timeTickMs: 1,
  beliefDecayRate: 0.08,
  sensingRange: 5,

  // Scouting and exploration behavior.
  scoutCooldownTicks: 200,
  scoutCongestionPenalty: 10,
  maxStalenessValue: 10000,
  greenInfoMultiplier: 4,
  redInfoMultiplier: 0.2,
  localExploreReversePenalty: 20,
  localExploreInfoWeight: 1,
  coverageSectorSize: 5,
  returnToRedWeight: 0.1,
  unifiedScoutCheckpointCount: 24,
  unifiedScoutStalenessWeight: 1.0,
  unifiedScoutDistanceWeight: 0.0,
  unifiedScoutTopKForRedTieBreak: 5,
  unifiedScoutRepeatTargetPenalty: 50,
  unifiedScoutRepeatSectorPenalty: 10,
  failedScoutTargetCooldownTicks: 40,

  // Candidate selection and green clustering.
  clusterPickupRadius: 3,
  clusterPickupBonusWeight: 0.6,
  minClusterPackageValue: 3,
  localCandidateRadius: 4,
  localCandidateLimit: 4,
  clusterExpansionRadius: 3,
  clusterExpansionLimit: 6,
  maxCandidateGreens: 16,

  // Search cost, safety, and planning budget.
  trapPenalty: 1000000,
  planningBudgetMs: 200,
  topKRedCandidates: 5,

  // Recovery from blocked movement.
  enableEdgeTemporaryBlocks: true,
  temporaryEdgeBlockTtlTicks: 2000,
  maxRepeatedBlockedMovesBeforeReplan: 2,

  // Search breadth limits.
  beamWidth: 100,
  topK: 16
});

export function createConfig(env = process.env) {
  const agentType = requiredAgentType(env);
  const adminId = env.ADMIN_ID ?? null;
  const llmEnabled = agentType === "llm";
  const chatEnabled = llmEnabled && Boolean(adminId);

  return {
    host: normalizeHost(env.HOST),
    token: env.TOKEN ?? "",
    agentName: env.AGENT_NAME ?? "PlannerAgent",
    teammateId: env.TEAMMATE_ID ?? null,
    logLevel: env.LOG_LEVEL ?? "info",
    agentType,
    actionDelayMs: numberFromEnv(env, "ACTION_DELAY_MS", 100),
    telemetryEnabled: booleanFromEnv(env, "TELEMETRY_ENABLED", false),
    telemetryFile: env.TELEMETRY_FILE ?? "telemetry.jsonl",
    telemetry: {
      enabled: booleanFromEnv(env, "TELEMETRY_ENABLED", false),
      file: env.TELEMETRY_FILE ?? "telemetry.jsonl"
    },
    planner: {
      ...DEFAULT_PLANNER_CONFIG
    },
    llm: {
      enabled: llmEnabled,
      chatEnabled,
      adminId,
      baseUrl: stringFromEnv(env, "LITELLM_BASE_URL", "https://llm.bears.disi.unitn.it/v1"),
      apiKey: env.LITELLM_API_KEY ?? "",
      model: stringFromEnv(env, "LOCAL_MODEL", "llama-3.3-70b-lmstudio"),
      diagnosticsEnabled: env.CHAT_DIAGNOSTICS_ENABLED !== "0",
      diagnosticsFile: stringFromEnv(env, "CHAT_DIAGNOSTICS_FILE", "logs/chat-diagnostics.jsonl"),
      maxToolIterations: Math.max(1, numberFromEnv(env, "CHAT_MAX_LLM_ITERATIONS", 8) || 8),
      maxTotalToolCalls: Math.max(1, numberFromEnv(env, "CHAT_MAX_TOOL_CALLS", 16) || 16),
      maxCalculatorExpressions: Math.max(1, numberFromEnv(env, "CHAT_CALCULATOR_MAX_EXPRESSIONS", 12) || 12),
      maxCalculatorExpressionLength: Math.max(8, numberFromEnv(env, "CHAT_CALCULATOR_MAX_EXPR_LENGTH", 120) || 120),
      disabledReason: llmEnabled && !adminId ? "missing_admin_id" : null
    }
  };
}

export function choosePlannerConfig(profile = {}, planner = DEFAULT_PLANNER_CONFIG) {
  const mode = "CONFIG_STATIC";
  const topK = Math.max(0, Math.min(asFinite(profile.greenCount, 0), asFinite(planner.topK, asFinite(profile.greenCount, 0))));
  const beamWidth = Math.max(1, Math.round(asFinite(planner.beamWidth, 1)));
  const topKRedCandidates = Math.max(0, Math.round(asFinite(planner.topKRedCandidates, 0)));
  const periodicBase = Math.max(0, Math.round(asFinite(planner.periodicReplanTicks, 0)));
  const periodicReplanTicks =
    Boolean(profile.hasDecay) && periodicBase > 1 ? Math.max(1, Math.floor(periodicBase / 2)) : periodicBase;

  return {
    ...planner,
    mode,
    topK,
    beamWidth,
    topKRedCandidates,
    periodicReplanTicks
  };
}
