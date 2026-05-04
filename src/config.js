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
    maxPackages: Infinity,
    kSmoothMax: 0.25,
    kWin: 1,
    rhoGeneration: 0.1,
    moveWeight: 1,
    betaCarry: 0.5,
    periodicReplanTicks: 2,
    timeTickMs: 1000,
    minParcelConfidence: 0.3,
    enemySafetyMargin: 0,
    beliefDecayRate: 0.08,
    sensingRange: 5,
    scoutCooldownTicks: 8,
    sameScoutTargetPenalty: 15,
    recentScoutPenalty: 10,
    scoutDistanceWeight: 1,
    scoutRedDistanceWeight: 0.2,
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
    clusterSizeWeight: 2,
    explorationDebtThreshold: 25,
    explorationDebtBonus: 20,
    opportunisticMaxDistance: 3,
    opportunisticPathRadius: 2,
    opportunisticMinGain: 5,
    opportunisticCongestionPenalty: 8,
    targetCongestionPenalty: 0,
    deliveryUrgencyWeight: 0,
    maxPlanningTimeMs: 30
  }
};
