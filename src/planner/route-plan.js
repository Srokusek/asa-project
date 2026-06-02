import { asNumber } from "./path/grid-utils.js";

function mapToObject(map) {
  return map instanceof Map ? Object.fromEntries(map) : map ?? {};
}

export function baseRoutePlan({
  mode,
  sequence,
  path,
  value,
  plan,
  profile,
  config,
  greenScores,
  candidateGreens = [],
  oracle,
  state,
  scoutTarget = null,
  invalidPlanDetected = false,
  fallbackStage = null,
  candidateDiagnostics = []
}) {
  return {
    mode,
    sequence,
    path,
    value,
    plan,
    profile,
    config,
    greenScores: mapToObject(greenScores),
    candidateGreens,
    scoutTarget,
    oracle,
    state,
    generatedAtTime: asNumber(state.time, 0),
    pathIndex: 0,
    invalidPlanDetected,
    fallbackStage,
    candidateDiagnostics,
    hasDirectionalTiles: Boolean(profile?.hasDirectionalTiles),
    directedDistanceFieldsBuilt: Boolean(state.__directedDistanceFields)
  };
}
