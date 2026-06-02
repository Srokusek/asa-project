function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function booleanFromEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function stringFromEnv(name, fallback = null) {
  const value = process.env[name];
  if (value === undefined || String(value).trim() === "") return fallback;
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

export const CONFIG = {
  host: normalizeHost(process.env.HOST),
  token: process.env.TOKEN ?? "",
  agentName: process.env.AGENT_NAME ?? "PlannerAgent",
  logLevel: process.env.LOG_LEVEL ?? "info",
  adminId: process.env.ADMIN_ID ?? null,
  actionDelayMs: numberFromEnv("ACTION_DELAY_MS", 0),
  telemetryEnabled: booleanFromEnv("TELEMETRY_ENABLED", false),
  telemetryFile: process.env.TELEMETRY_FILE ?? "telemetry.jsonl",
  telemetry: {
    enabled: booleanFromEnv("TELEMETRY_ENABLED", false),
    file: process.env.TELEMETRY_FILE ?? "telemetry.jsonl"
  },
  team: {
    standardAgentName: stringFromEnv("BDI_AGENT_NAME", process.env.AGENT_NAME ?? "StandardBDIAgent"),
    coordinationAgentName: stringFromEnv("LLM_AGENT_NAME", "CoordinationBDIAgent"),
    heartbeatTicks: numberFromEnv("TEAM_HEARTBEAT_TICKS", 5),
    heartbeatTtlTicks: numberFromEnv("TEAM_HEARTBEAT_TTL_TICKS", 15)
  },
  missions: {
    enabled: true
  },
  planner: {
    meanPackageValue: 10,
    packageVariance: 0,
    decayRate: 0.05,
    kWin: 1,
    moveWeight: 1,
    betaCarry: 0.5,
    periodicReplanTicks: 20000,
    timeTickMs: 50,
    minParcelConfidence: 0.3,
    enemySafetyMargin: 0,
    beliefDecayRate: 0.08,
    sensingRange: 5,
    scoutCooldownTicks: 8,
    scoutCongestionPenalty: 10,
    maxStalenessValue: 1000,
    greenInfoMultiplier: 4,
    redInfoMultiplier: 0.2,
    clusterPickupRadius: 3,
    clusterPickupBonusWeight: 0.6,
    minClusterPackageValue: 3,
    localCandidateRadius: 4,
    localCandidateLimit: 4,
    clusterExpansionRadius: 3,
    clusterExpansionLimit: 6,
    maxCandidateGreens: 16,
    localExploreReversePenalty: 20,
    localExploreInfoWeight: 1,
    failedScoutTargetCooldownTicks: 40,
    coverageSectorSize: 5,
    returnToRedWeight: 0.5,

    // parameters used by unified scout
    unifiedScoutCheckpointCount: 24,
    unifiedScoutStalenessWeight: 50.0,
    unifiedScoutDistanceWeight: 0.2,
    unifiedScoutTopKForRedTieBreak: 5,
    unifiedScoutRepeatTargetPenalty: 50,
    unifiedScoutRepeatSectorPenalty: 10,
    trapPenalty: 10000,
    planningBudgetMs: 50,
    topKRedCandidates: 5,
    enableEdgeTemporaryBlocks: true,
    temporaryEdgeBlockTtlTicks: 2,
    maxRepeatedBlockedMovesBeforeReplan: 2,
    targetCongestionPenalty: 0,
    immediatePickupMaxDistance: 4,
    deliveryDeferralNearbyRadius: 4,
    deliveryDeferralMinNearbyValue: 1,
    deliveryDeferralCloseRedDistance: 2,
    shortHarvestBudgetMs: 15,
    shortHarvestMaxCandidates: 8,
    shortHarvestMinCandidates: 2,
    shortHarvestDepth: 4,
    shortHarvestBeamWidth: 8,
    shortHarvestMinValue: 0,
    zoneMemorySectorSize: 5,
    zoneMemoryReturnToRedWeight: 0.5,
    zoneMemoryScoutWeight: 0.25,

    // search parameters
    beamWidth: 48,
    topK: 12,
  }
};

function normalizeRole(role) {
  const normalized = String(role ?? "bdi").trim().toLowerCase();
  if (["llm", "coordination", "coordinator"].includes(normalized)) return "llm";
  return "bdi";
}

function effectiveRoleToken(baseConfig, role) {
  const fallbackToken = stringFromEnv("TOKEN", baseConfig.token ?? "");
  if (role === "llm") {
    return stringFromEnv("LLM_TOKEN", baseConfig.llmAgentToken ?? fallbackToken);
  }
  return stringFromEnv("BDI_TOKEN", baseConfig.bdiToken ?? fallbackToken);
}

function effectiveRoleName(baseConfig, role) {
  if (role === "llm") {
    return stringFromEnv(
      "LLM_AGENT_NAME",
      baseConfig.team?.coordinationAgentName ?? `${baseConfig.agentName ?? "CoordinationBDIAgent"}-LLM`
    );
  }
  return stringFromEnv(
    "BDI_AGENT_NAME",
    baseConfig.team?.standardAgentName ?? baseConfig.agentName ?? "StandardBDIAgent"
  );
}

function llmConfigFromEnv(baseConfig) {
  return {
    ...(baseConfig.llm ?? {}),
    baseURL: stringFromEnv("LITELLM_BASE_URL", baseConfig.llm?.baseURL ?? "https://llm.bears.disi.unitn.it/v1"),
    apiKey: stringFromEnv("LITELLM_API_KEY", baseConfig.llm?.apiKey ?? ""),
    model: stringFromEnv("LOCAL_MODEL", baseConfig.llm?.model ?? "llama-3.3-70b-lmstudio")
  };
}

export function buildRoleConfig(baseConfig = CONFIG, role = process.env.AGENT_ROLE) {
  const agentRole = normalizeRole(role);
  const bdiToken = effectiveRoleToken(baseConfig, "bdi");
  const llmToken = effectiveRoleToken(baseConfig, "llm");
  const standardAgentName = effectiveRoleName(baseConfig, "bdi");
  const coordinationAgentName = effectiveRoleName(baseConfig, "llm");
  const token = agentRole === "llm" ? llmToken : bdiToken;
  const agentName = agentRole === "llm" ? coordinationAgentName : standardAgentName;

  if (bdiToken && llmToken && bdiToken === llmToken) {
    console.warn(
      "[config] StandardBDIAgent and CoordinationBDIAgent resolve to the same Deliveroo token. " +
      "Set distinct BDI_TOKEN and LLM_TOKEN for two separate agents."
    );
  }

  const { llm: _llm, ...configWithoutLlm } = baseConfig;
  const roleConfig = {
    ...configWithoutLlm,
    token,
    agentName,
    agentRole,
    team: {
      ...(baseConfig.team ?? {}),
      standardAgentName,
      coordinationAgentName,
      selfRole: agentRole,
      selfName: agentName,
      peerName: agentRole === "llm" ? standardAgentName : coordinationAgentName
    },
    missions: {
      ...(baseConfig.missions ?? {}),
      enabled: baseConfig.missions?.enabled ?? true
    }
  };

  if (agentRole === "llm") {
    roleConfig.llm = llmConfigFromEnv(baseConfig);
  }

  return roleConfig;
}

export function choosePlannerConfig(profile = {}, planner = CONFIG.planner) {
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
