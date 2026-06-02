import { positionKey } from "../utils/geometry.js";

export function detectOscillation(recentPositions = []) {
  if (!Array.isArray(recentPositions) || recentPositions.length < 4) return false;
  const last = recentPositions.slice(-4).map(positionKey);
  return last[0] === last[2] && last[1] === last[3] && last[0] !== last[1];
}

export function trafficPolicyForBlockedMove({ beliefs, action, repeatedCount = 1, config, sidestepAction = null } = {}) {
  const repeatedLimit = Number(config?.planner?.maxRepeatedBlockedMovesBeforeReplan ?? 2);
  const oscillating = detectOscillation([
    ...(beliefs?.recentPositions ?? []),
    beliefs?.me ? { x: beliefs.me.x, y: beliefs.me.y } : null
  ].filter(Boolean));

  if (oscillating && action?.from && action?.to) {
    beliefs?.markTemporaryBlockedEdge?.(
      action.to,
      action.from,
      Number(config?.planner?.temporaryEdgeBlockTtlTicks ?? 2),
      "oscillation_reverse_penalty"
    );
  }

  if (sidestepAction && repeatedCount >= repeatedLimit) {
    return {
      type: "sidestep",
      action: sidestepAction,
      reason: oscillating ? "oscillation_sidestep" : "enemy_block_sidestep"
    };
  }

  if (repeatedCount < repeatedLimit) {
    return {
      type: "wait",
      reason: oscillating ? "oscillation_wait" : "enemy_block_wait"
    };
  }

  return {
    type: "replan",
    reason: oscillating ? "oscillation_replan" : "enemy_block_replan"
  };
}
