import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { manhattan } from "../utils/geometry.js";

export function createChatDiagnostics({ logger, config }) {
  let chatLogReady = false;
  const enabled = Boolean(config?.llm?.diagnosticsEnabled);
  const diagnosticsFile = resolve(config?.llm?.diagnosticsFile || "logs/chat-diagnostics.jsonl");

  return async function writeChatDiagnostics(entry) {
    if (!enabled) return;
    try {
      if (!chatLogReady) {
        await mkdir(dirname(diagnosticsFile), { recursive: true });
        chatLogReady = true;
      }
      await appendFile(
        diagnosticsFile,
        `${JSON.stringify({
          ts: new Date().toISOString(),
          ...entry
        })}\n`,
        "utf8"
      );
    } catch (error) {
      logger.warn("chat diagnostics write failed", { error: error.message });
    }
  };
}

function eventType(event) {
  return typeof event === "string" ? event : event?.type;
}

function forbiddenTileEventPayload(event) {
  if (!event || typeof event !== "object") return null;
  const type = event.type;
  if (!type || !String(type).startsWith("FORBIDDEN_TILE_")) return null;
  const x = Number(event.payload?.x ?? event.payload?.target?.x);
  const y = Number(event.payload?.y ?? event.payload?.target?.y);
  return {
    type,
    x: Number.isFinite(x) ? x : null,
    y: Number.isFinite(y) ? y : null,
    reason: event.payload?.reason
  };
}

function multiplierEventPayload(event) {
  if (!event || typeof event !== "object") return null;
  const type = event.type;
  if (!type || !String(type).includes("MULTIPLIER_")) return null;
  const x = Number(event.payload?.x ?? event.payload?.target?.x);
  const y = Number(event.payload?.y ?? event.payload?.target?.y);
  const multiplier = Number(event.payload?.multiplier);
  const count = Number(event.payload?.count);
  return {
    type,
    x: Number.isFinite(x) ? x : null,
    y: Number.isFinite(y) ? y : null,
    count: Number.isFinite(count) ? count : null,
    multiplier: Number.isFinite(multiplier) ? multiplier : null,
    reason: event.payload?.reason
  };
}

function summarizeEvents(events = []) {
  const counts = new Map();

  for (const event of events) {
    const type = eventType(event);
    if (!type) continue;
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }

  if (counts.size === 0) return "missing_or_periodic_plan";

  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([type, count]) => `${type}x${count}`)
    .join(",");
}

function summarizeScoutTarget(target) {
  if (!target) return null;
  const rawId = String(target.id ?? "");
  const compactId =
    rawId.length > 80 ? `${rawId.slice(0, 60)}...` : rawId;
  return {
    id: compactId,
    score: target.score,
    primaryScore: target.primaryScore,
    position: target.position,
    distanceFromMe: target.distanceFromMe,
    distanceToNearestRed: target.distanceToNearestRed,
    trapPenaltyApplied: target.trapPenaltyApplied,
    pathCost: target.pathCost,
    checkpointValue: target.checkpointValue,
    stalenessComponent: target.stalenessComponent,
    multiplierComponent: target.multiplierComponent,
    repeatPenalty: target.repeatPenalty,
    coveredGreenCount: target.coveredGreenCount,
    sampleGreenIds: Array.isArray(target.sampleGreenIds) ? target.sampleGreenIds.slice(0, 5) : undefined
  };
}

function compactSequence(sequence = []) {
  if (!Array.isArray(sequence)) return { text: "", sequenceLength: 0, truncated: false };
  if (sequence.length <= 8) {
    return { text: sequence.join(" -> "), sequenceLength: sequence.length, truncated: false };
  }
  return {
    text: `${sequence[0]} -> ${sequence[1]} -> ${sequence[2]} -> ... -> ${sequence.at(-1)}`,
    sequenceLength: sequence.length,
    truncated: true
  };
}

function compactCandidateDiagnostics(diagnostics = []) {
  if (!Array.isArray(diagnostics)) return [];
  const compact = diagnostics.slice(0, 10);
  if (diagnostics.length <= 10) return compact;
  return [...compact, { truncated: true, total: diagnostics.length }];
}

function compactScoutTargetId(id) {
  const rawId = String(id ?? "");
  if (rawId.length <= 80) return rawId;
  return `${rawId.slice(0, 60)}...`;
}

function summarizeVisiblePackages(routePlan, beliefs, config) {
  const minConfidence = Number(config?.planner?.minParcelConfidence ?? 0.3);
  const candidatePackageIds = new Set(
    (routePlan?.candidateGreens ?? [])
      .map((green) => green.package?.id)
      .filter((id) => id !== undefined && id !== null)
      .map(String)
  );
  const ignoredVisiblePackages = [];
  let visiblePackagesCount = 0;

  for (const parcel of beliefs.parcels.values()) {
    if (parcel.carriedBy) continue;
    const reward = beliefs.estimateParcelReward?.(parcel) ?? Number(parcel.reward ?? 0);
    const confidence = Number(parcel.confidence ?? 0);
    const lastSeenTime = Number(parcel.lastSeenTime ?? -Infinity);
    const isVisible = confidence >= 1 || lastSeenTime >= Number(beliefs.time ?? 0);
    if (!isVisible || reward <= 0 || confidence < minConfidence) continue;

    visiblePackagesCount += 1;
    if (candidatePackageIds.has(String(parcel.id))) continue;
    if (ignoredVisiblePackages.length >= 10) continue;

    ignoredVisiblePackages.push({
      id: String(parcel.id),
      reward,
      confidence,
      distance: beliefs.me ? manhattan(beliefs.me, parcel) : null,
      reason: "not_candidate"
    });
  }

  return {
    visiblePackagesCount,
    candidatePackagesCount: candidatePackageIds.size,
    ignoredVisiblePackages
  };
}

function buildOracleStats(routePlan) {
  return {
    oraclePoints: routePlan.oracle?.points?.length ?? 0,
    oraclePathfindingCalls: routePlan.oracle?.stats?.pathfindingCalls ?? 0,
    oracleSingleSourceBfsRuns: routePlan.oracle?.stats?.singleSourceBfsRuns ?? 0,
    oracleEdgeRequests: routePlan.oracle?.stats?.edgeRequests ?? 0,
    oracleLazyEdgeComputes: routePlan.oracle?.stats?.lazyEdgeComputes ?? 0,
    oracleCostCacheHits: routePlan.oracle?.stats?.costCacheHits ?? 0,
    oraclePathComputes: routePlan.oracle?.stats?.pathComputes ?? 0,
    staticIndexBuildMs: routePlan.oracle?.stats?.staticIndexBuildMs ?? 0,
    staticIndexReuseCount: routePlan.oracle?.stats?.staticIndexReuseCount ?? 0,
    startSingleSourceMs: routePlan.oracle?.stats?.startSingleSourceMs ?? 0,
    dynamicPathRepairs: routePlan.oracle?.stats?.dynamicPathRepairs ?? 0,
    dynamicRepairFailReplans: routePlan.oracle?.stats?.dynamicRepairFailReplans ?? 0,
    redDistanceCacheHit: routePlan.oracle?.stats?.redDistanceCacheHit ?? 0,
    redDistanceCacheMiss: routePlan.oracle?.stats?.redDistanceCacheMiss ?? 0,
    redDistanceCacheBuildMs: routePlan.oracle?.stats?.redDistanceCacheBuildMs ?? 0,
    redDistanceCacheTopologyHit: routePlan.oracle?.stats?.redDistanceCacheTopologyHit ?? 0
  };
}

function buildPlannerSummary(beliefs, plannerState) {
  return {
    width: plannerState.width,
    height: plannerState.height,
    greens: plannerState.greens.length,
    greensWithPackage: plannerState.greens.filter((green) => green.package).length,
    reds: plannerState.reds.length,
    parcelsInBelief: beliefs.parcels.size,
    carried: beliefs.carriedParcels.size,
    temporaryBlockedCells: beliefs.temporaryBlockedCells?.size ?? 0,
    pickupMultiplierRules: beliefs.pickupTileMultipliers?.size ?? 0,
    deliveryMultiplierRules: beliefs.deliveryTileMultipliers?.size ?? 0,
    me: beliefs.me
  };
}

function adjustedDeliveredEstimateMax(routePlan) {
  const adjustedValues = (routePlan?.candidateDiagnostics ?? [])
    .map((entry) => Number(entry?.estimatedDeliveredValue))
    .filter((value) => Number.isFinite(value));
  return adjustedValues.length > 0 ? Math.max(...adjustedValues) : null;
}

function currentBeliefPosition(beliefs) {
  return beliefs.me ? { x: beliefs.me.x, y: beliefs.me.y } : null;
}

export function createAgentLoopDiagnostics({ logger, telemetry, config }) {
  const repeatedBlockedMoveLimit = Number(config?.planner?.maxRepeatedBlockedMovesBeforeReplan ?? 2);

  return {
    recordBeliefEvents(events = []) {
      for (const event of events) {
        const forbiddenTilePayload = forbiddenTileEventPayload(event);
        if (forbiddenTilePayload) {
          if (forbiddenTilePayload.type === "FORBIDDEN_TILE_ADDED") {
            telemetry.record("forbidden_tile_added", forbiddenTilePayload);
          } else if (forbiddenTilePayload.type === "FORBIDDEN_TILE_REJECTED") {
            telemetry.record("forbidden_tile_rejected", forbiddenTilePayload);
          }
        }

        const payload = multiplierEventPayload(event);
        if (!payload) continue;
        if (payload.type === "PICKUP_MULTIPLIER_SET") {
          telemetry.record("pickup_multiplier_set", payload);
        } else if (payload.type === "DELIVERY_MULTIPLIER_SET") {
          telemetry.record("delivery_multiplier_set", payload);
        } else if (payload.type === "DELIVERY_COUNT_MULTIPLIER_SET") {
          telemetry.record("delivery_count_multiplier_set", payload);
        }
      }
    },

    onPlannerStateSummary({ beliefs, plannerState, routePlan }) {
      logger.debug("planner state summary", {
        ...buildPlannerSummary(beliefs, plannerState),
        mode: routePlan.mode
      });
    },

    onNonIdleZeroActionPlan({ routePlan }) {
      const sequenceSummary = compactSequence(routePlan?.sequence);
      logger.warn("non-idle plan produced zero actions", {
        mode: routePlan?.mode,
        sequence: sequenceSummary.text,
        sequenceLength: sequenceSummary.sequenceLength,
        sequenceTruncated: sequenceSummary.truncated
      });
    },

    onNonExecutablePath({ routePlan }) {
      const sequenceSummary = compactSequence(routePlan?.sequence);
      logger.warn("planner produced a non-executable path", {
        sequence: sequenceSummary.text,
        sequenceLength: sequenceSummary.sequenceLength,
        sequenceTruncated: sequenceSummary.truncated
      });
    },

    onInvalidZeroActionPlan({ routePlan, invalidNonIdleZeroActionCount, invalidTargetPlanLimit }) {
      const sequenceSummary = compactSequence(routePlan?.sequence);
      logger.warn("invalid non-idle zero-action plan", {
        mode: routePlan?.mode,
        sequence: sequenceSummary.text,
        sequenceLength: sequenceSummary.sequenceLength,
        sequenceTruncated: sequenceSummary.truncated,
        invalidNonIdleZeroActionCount,
        fallbackStage:
          invalidNonIdleZeroActionCount >= invalidTargetPlanLimit ? "scout" : routePlan?.fallbackStage
      });
    },

    onManualTaskCleared({ task }) {
      logger.info("manual task cleared", {
        taskId: task?.id,
        taskKey: task?.payload?.taskKey ?? null
      });
    },

    onManualTaskRetry({ taskId, reason, target, logReason = reason }) {
      telemetry.record("manual_task_retry", {
        taskId,
        reason,
        target
      });
      logger.warn("manual task retry", {
        taskId,
        reason: logReason,
        target
      });
    },

    onManualTaskStarted({ taskId, routePlan, actionCount }) {
      telemetry.record("manual_task_started", {
        taskId,
        mode: routePlan?.mode,
        target: routePlan?.manualTarget ?? null,
        actionCount
      });
      logger.info("manual task started", {
        taskId,
        target: routePlan?.manualTarget ?? null,
        actionCount
      });
    },

    onReplan({ beliefs, plannerState, routePlan, executablePlan, events, replanCause, elapsedMs }) {
      const plannerSummary = buildPlannerSummary(beliefs, plannerState);
      const sequenceSummary = compactSequence(routePlan?.sequence);
      const candidateDiagnostics = compactCandidateDiagnostics(routePlan?.candidateDiagnostics);
      const visiblePackageSummary = summarizeVisiblePackages(routePlan, beliefs, config);
      const scoutTarget = summarizeScoutTarget(routePlan?.scoutTarget);
      const oracleStats = buildOracleStats(routePlan);
      const adjustedEstimateMax = adjustedDeliveredEstimateMax(routePlan);
      const eventsSeen = summarizeEvents(events);
      const hasDirectionalTiles = Boolean(routePlan?.hasDirectionalTiles ?? routePlan?.profile?.hasDirectionalTiles);
      const directedDistanceFieldsBuilt = Boolean(routePlan?.directedDistanceFieldsBuilt);
      const activePickupMultiplierRules = beliefs.pickupTileMultipliers?.size ?? 0;
      const activeDeliveryMultiplierRules = beliefs.deliveryTileMultipliers?.size ?? 0;

      logger.info("replan", {
        eventsSeen,
        replanCause,
        mode: routePlan.mode,
        sequence: sequenceSummary.text,
        sequenceLength: sequenceSummary.sequenceLength,
        sequenceTruncated: sequenceSummary.truncated,
        value: routePlan.value,
        actions: executablePlan.length,
        candidates: (routePlan.candidateGreens ?? []).map((green) => green.id).join(","),
        invalidPlanDetected: Boolean(routePlan.invalidPlanDetected),
        fallbackStage: routePlan.fallbackStage ?? "full_plan",
        hasDirectionalTiles,
        directedDistanceFieldsBuilt,
        candidateDiagnostics,
        ...visiblePackageSummary,
        activePickupMultiplierRules,
        activeDeliveryMultiplierRules,
        adjustedDeliveredEstimateMax: adjustedEstimateMax,
        scoutTarget,
        ...oracleStats,
        greenRecentlyVisited: routePlan.scoutTarget
          ? beliefs.greenRecentlyVisited?.(
              routePlan.scoutTarget.id,
              config?.planner?.scoutCooldownTicks ?? 8
            )
          : undefined,
        temporaryBlockedCells: beliefs.temporaryBlockedCells?.size ?? 0,
        elapsedMs
      });

      telemetry.record("replan", {
        mode: routePlan.mode,
        currentPosition: plannerState.me?.position,
        target: routePlan.scoutTarget?.position ?? routePlan.path?.at?.(-1) ?? null,
        sequence: sequenceSummary.text,
        sequenceLength: sequenceSummary.sequenceLength,
        sequenceTruncated: sequenceSummary.truncated,
        expectedValue: routePlan.value,
        score: beliefs.me?.score,
        parcelsInBelief: beliefs.parcels.size,
        greensWithPackage: plannerSummary.greensWithPackage,
        carriedCount: beliefs.carriedParcels.size,
        planningTimeMs: elapsedMs,
        temporaryBlockedCells: beliefs.temporaryBlockedCells?.size ?? 0,
        scoutTarget: compactScoutTargetId(routePlan.scoutTarget?.id),
        scoutTargetDetails: scoutTarget,
        candidateCount: routePlan.candidateGreens?.length ?? 0,
        invalidPlanDetected: Boolean(routePlan.invalidPlanDetected),
        fallbackStage: routePlan.fallbackStage ?? "full_plan",
        hasDirectionalTiles,
        directedDistanceFieldsBuilt,
        candidateDiagnostics,
        ...visiblePackageSummary,
        activePickupMultiplierRules,
        activeDeliveryMultiplierRules,
        adjustedDeliveredEstimateMax: adjustedEstimateMax,
        ...oracleStats,
        actionCount: executablePlan.length,
        eventsSeen,
        replanCause,
        reason: replanCause
      });
    },

    onPlanningExceededBudget({ elapsedMs, budgetMs }) {
      logger.warn("planning exceeded budget", { elapsedMs, budgetMs });
    },

    onExecuteAction({ routePlan, action, actionIndex }) {
      logger.debug("execute action", {
        index: actionIndex,
        action,
        sequence: compactSequence(routePlan?.sequence).text
      });
    },

    onEnemyBlockedMove({ beliefs, routePlan, action, repeated }) {
      logger.warn("enemy_in_next_cell", {
        blockedCell: action?.to,
        repeatedBlockedMove: repeated,
        temporaryBlockedCells: beliefs.temporaryBlockedCells?.size ?? 0
      });
      telemetry.record("enemy_in_next_cell", {
        mode: routePlan?.mode,
        currentPosition: currentBeliefPosition(beliefs),
        action,
        result: false,
        temporaryBlockedCells: beliefs.temporaryBlockedCells?.size ?? 0
      });
      if (repeated >= repeatedBlockedMoveLimit) {
        logger.warn("repeatedBlockedMove", {
          action,
          sameBlockedMoveCount: repeated,
          reason: "enemy_in_next_cell"
        });
      }
    },

    onMoveFailed({ beliefs, action, consecutiveMoveFailures, sameBlockedMoveCount }) {
      logger.warn("move failed", {
        blockedCell: action?.to,
        consecutiveMoveFailures,
        sameBlockedMoveCount,
        temporaryBlockedCells: beliefs.temporaryBlockedCells?.size ?? 0
      });
    },

    onRepeatedBlockedMove({ routePlan, action, sameBlockedMoveCount, reason }) {
      logger.warn("repeatedBlockedMove", {
        action,
        sameBlockedMoveCount,
        reason
      });
      telemetry.record("repeated_blocked_move", {
        mode: routePlan?.mode,
        action,
        sameBlockedMoveCount
      });
    },

    onForcedSidestep({ action, consecutiveMoveFailures }) {
      logger.warn("forced sidestep after repeated move failure", {
        action,
        consecutiveMoveFailures
      });
    },

    onActionStart({ beliefs, routePlan, action }) {
      telemetry.record("action_start", {
        mode: routePlan?.mode,
        currentPosition: currentBeliefPosition(beliefs),
        target: routePlan?.path?.at?.(-1) ?? null,
        sequence: compactSequence(routePlan?.sequence).text,
        action,
        score: beliefs.me?.score,
        expectedValue: routePlan?.value,
        parcelsInBelief: beliefs.parcels.size,
        greensWithPackage: routePlan?.state?.greens?.filter((green) => green.package).length ?? 0,
        carriedCount: beliefs.carriedParcels.size,
        temporaryBlockedCells: beliefs.temporaryBlockedCells?.size ?? 0,
        scoutTarget: routePlan?.scoutTarget?.id,
        candidateCount: routePlan?.candidateGreens?.length ?? 0
      });
    },

    onActionFailed({ beliefs, routePlan, action, consecutiveMoveFailures }) {
      telemetry.record("action_failed", {
        mode: routePlan?.mode,
        action,
        result: false,
        consecutiveMoveFailures,
        temporaryBlockedCells: beliefs.temporaryBlockedCells?.size ?? 0
      });
    },

    onPlanCompleted({ beliefs, routePlan }) {
      telemetry.record("plan_completed", {
        mode: routePlan?.mode,
        sequence: compactSequence(routePlan?.sequence).text,
        scoutTarget: compactScoutTargetId(routePlan?.scoutTarget?.id),
        currentPosition: currentBeliefPosition(beliefs)
      });
    },

    onManualTaskWaiting({ task, routePlan }) {
      const target = routePlan?.manualTarget ?? task?.payload?.target ?? null;
      telemetry.record("manual_task_waiting", {
        taskId: task?.id,
        target,
        taskKey: task?.payload?.taskKey ?? null
      });
      logger.info("manual task waiting", {
        taskId: task?.id,
        target,
        taskKey: task?.payload?.taskKey ?? null
      });
    },

    onManualTaskCompleted({ task, routePlan }) {
      const target = routePlan?.manualTarget ?? task?.payload?.target ?? null;
      telemetry.record("manual_task_completed", {
        taskId: task?.id,
        target
      });
      logger.info("manual task completed", {
        taskId: task?.id,
        target
      });
    }
  };
}
