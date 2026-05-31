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
    decayRate: 1,
    generationMeanTime: null,
    generationProbability: null,
    kSmoothMax: 0.25,
    kWin: 1,
    rhoGeneration: 0.1,
    moveWeight: 1,
    betaCarry: 0.5,
    periodicReplanTicks: 20,
    timeTickMs: 1000,
    minParcelConfidence: 0.3,
    enemySafetyMargin: 0,
    beliefDecayRate: 0.08,
    sensingRange: 5,
    scoutCooldownTicks: 8,
    sameScoutTargetPenalty: 15,
    recentScoutPenalty: 10,
    scoutDistanceWeight: 0.8,
    scoutRedDistanceWeight: 0.1,
    scoutFutureWeight: 2,
    scoutCongestionDistance: 2,
    scoutEnemyDistance: 2,
    scoutCongestionPenalty: 10,
    noveltyBonus: 5,
    emptyGreenFutureWeight: 0,
    maxStalenessValue: 30,
    greenInfoMultiplier: 4,
    redInfoMultiplier: 0.2,
    infoValueWeight: 1,
    clusterPickupRadius: 3,
    clusterPickupBonusWeight: 0.6,
    minClusterPackageValue: 3,
    greenClusterDistance: 2,
    clusterSizeWeight: 3,
    explorationDebtThreshold: 25,
    explorationDebtBonus: 30,
    localCandidateRadius: 4,
    localCandidateLimit: 4,
    clusterExpansionRadius: 3,
    clusterExpansionLimit: 6,
    maxCandidateGreens: 16,
    localExploreReversePenalty: 20,
    localExploreInfoWeight: 1,
    denseGreenThreshold: 0.65,
    denseGreenMinGreens: 100,
    denseScoutRadius: 6,
    denseScoutMaxWaypoints: 12,
    denseScoutMinDistanceFromLastDelivery: 2,
    greenExposureDepth: 6,
    greenExposureBeamWidth: 16,
    greenExposureMaxExpanded: 48,
    greenExposureMinPlanLength: 3,
    greenExposureStaleWeight: 2,
    greenExposureNewTileWeight: 1,
    greenExposureGreenWeight: 1,
    greenExposureDistanceWeight: 1,
    greenExposureBacktrackPenalty: 5,
    minGreenExposureScore: 0,
    positionRevisitPenalty: 4,
    edgeRevisitPenalty: 6,
    sameTargetPenalty: 30,
    sameSectorPenalty: 20,
    failedScoutTargetPenalty: 50,
    failedScoutTargetCooldownTicks: 40,
    edgeCooldownTicks: 20,
    positionCooldownTicks: 20,
    coverageSectorSize: 5,
    returnToRedWeight: 0.5,
    trapPenalty: 10000,
    planningBudgetMs: 30,
    hardPlanningBudgetMs: 100,
    mazeObstacleDensityThreshold: 0.25,
    enableEdgeTemporaryBlocks: true,
    temporaryEdgeBlockTtlTicks: 2,
    maxRepeatedBlockedMovesBeforeReplan: 2,
    opportunisticMaxDistance: 3,
    opportunisticPathRadius: 2,
    opportunisticCheckIntervalTicks: 2,
    opportunisticMinGain: 5,
    opportunisticCongestionPenalty: 8,
    targetCongestionPenalty: 0,
    deliveryUrgencyWeight: 0,
    maxPlanningTimeMs: 30
  }
};
