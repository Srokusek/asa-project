function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function normalizeHost(host) {
  const raw = String(host || "deliveroojs.azurewebsites.net").trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

export const CONFIG = {
  host: normalizeHost(process.env.HOST),
  token: process.env.TOKEN ?? "",
  agentName: process.env.AGENT_NAME ?? "PlannerAgent",
  logLevel: process.env.LOG_LEVEL ?? "info",
  actionDelayMs: numberFromEnv("ACTION_DELAY_MS", 100),
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
    minParcelConfidence: 0.3,
    enemySafetyMargin: 0,
    beliefDecayRate: 0.08,
    maxPlanningTimeMs: 30
  }
};
