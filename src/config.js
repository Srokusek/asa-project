function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function booleanFromEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
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
  actionDelayMs: numberFromEnv("ACTION_DELAY_MS", 100),
  telemetryEnabled: booleanFromEnv("TELEMETRY_ENABLED", false),
  telemetryFile: process.env.TELEMETRY_FILE ?? "telemetry.jsonl",
  telemetry: {
    enabled: booleanFromEnv("TELEMETRY_ENABLED", false),
    file: process.env.TELEMETRY_FILE ?? "telemetry.jsonl"
  },
  planner: {
    meanPackageValue: 10,
    packageVariance: 0,
    decayRate: 0.05,
    kWin: 1,
    ignoreEnemyEta: true,
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
    maxStalenessValue: 10000,
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
    unifiedScoutStalenessWeight: 1.0,
    unifiedScoutDistanceWeight: 1.0,
    unifiedScoutTopKForRedTieBreak: 5,
    unifiedScoutRepeatTargetPenalty: 50,
    unifiedScoutRepeatSectorPenalty: 10,
    trapPenalty: 10000,
    planningBudgetMs: 200,
    topKRedCandidates: 5,
    enableEdgeTemporaryBlocks: true,
    temporaryEdgeBlockTtlTicks: 2,
    maxRepeatedBlockedMovesBeforeReplan: 2,
    targetCongestionPenalty: 0,

    // search parameters
    beamWidth: 100,
    topK: 16,
  }
};

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
