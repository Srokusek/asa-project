import { normalizeSensingRange } from "./belief-state.js";
import { applyTeammateSyncMessage } from "../utils/teammate-sync.js";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeYouArgs(args) {
  if (args.length === 1 && typeof args[0] === "object") return args[0];
  const [id, name, x, y, score, penalty] = args;
  return { id, name, x, y, score, penalty };
}

function normalizeTileArgs(args) {
  if (args.length === 1 && typeof args[0] === "object") return args[0];
  const [x, y, third] = args;

  if (typeof third === "boolean") {
    return {
      x,
      y,
      type: third ? "2" : "3"
    };
  }

  return { x, y, type: third };
}

function normalizeChatArgs(args) {
  if (args.length === 1 && typeof args[0] === "object") {
    const message = args[0];
    return {
      ...message,
      fromId: message.fromId ?? message.id ?? message.from ?? null,
      fromName: message.fromName ?? message.name ?? null,
      text: String(message.text ?? message.msg ?? message.message ?? "")
    };
  }

  if (args.length >= 4) {
    const [fromId, fromName, msg] = args;
    return {
      fromId,
      fromName,
      text: String(msg ?? "")
    };
  }

  if (args.length === 3) {
    const [fromId, fromName, msg] = args;
    return { fromId, fromName, text: String(msg ?? "") };
  }

  if (args.length === 2) {
    const [fromId, msg] = args;
    return { fromId, text: String(msg ?? "") };
  }

  return { text: String(args[0] ?? "") };
}

function observedSensingRange(config) {
  return normalizeSensingRange(config?.GAME?.player?.observation_distance, null);
}

function isReleaseMessage(text) {
  const normalized = String(text ?? "").trim().toLowerCase();
  return normalized === "/clear" || normalized === "green light" || normalized === "greenlight";
}

function clearManualState(beliefs, fromId, logger) {
  const removed = beliefs.clearAllManualTasks?.() ?? [];
  const handoffCleared = beliefs.clearParcelHandoffTask?.("teammate_clear") ?? false;
  if (removed.length > 0 || handoffCleared) {
    logger?.info?.("manual state cleared", {
      fromId: fromId ?? null,
      taskIds: removed.map((task) => task.id),
      parcelHandoffCleared: Boolean(handoffCleared)
    });
  }
  return removed.length > 0 || handoffCleared;
}

export function registerSdkListeners(socket, beliefs, config, logger = null) {
  socket.on("connect", () => {
    beliefs.pushEvent("CONNECTED");
  });

  socket.on("disconnect", (reason) => {
    beliefs.pushEvent("DISCONNECTED", { reason });
  });

  socket.on("config", (runtimeConfig) => {
    const rewardAvg = Number(runtimeConfig?.GAME?.parcels?.reward_avg);
    if (Number.isFinite(rewardAvg)) {
      beliefs.meanPackageValue = rewardAvg;
    }

    const sensingRange = observedSensingRange(runtimeConfig);
    if (sensingRange !== null) {
      beliefs.updateSensingRange?.(sensingRange, "sdk_config");
    }
  });

  socket.on("you", (...args) => {
    beliefs.updateSelf(normalizeYouArgs(args));
  });

  socket.on("map", (width, height, tiles) => {
    beliefs.updateMap(width, height, asArray(tiles));
  });

  socket.on("tile", (...args) => {
    beliefs.updateTile(normalizeTileArgs(args));
  });

  socket.on("agentsSensing", (agents = []) => {
    beliefs.updateAgentsSensing(asArray(agents));
  });

  socket.on("parcelsSensing", (parcels = []) => {
    const visible = beliefs.visiblePositionsFromSelf();
    beliefs.updateParcelsSensing(asArray(parcels), visible);
  });

  socket.on("sensing", (sensing = {}) => {
    beliefs.updateSensing({
      positions: asArray(sensing.positions),
      agents: asArray(sensing.agents),
      parcels: asArray(sensing.parcels)
    });
  });

  socket.on("msg", (...args) => {
    const normalized = normalizeChatArgs(args);
    const fromId = String(normalized.fromId ?? "");
    const teammateId = String(config?.teammateId ?? "");
    const text = String(normalized.text ?? "").trim();
    const isAdminRelease = fromId === String(config?.llm?.adminId ?? "") && isReleaseMessage(text);
    const isTeammateRelease = teammateId && fromId === teammateId && isReleaseMessage(text);

    if (config?.agentType === "bdi") {
      if (!teammateId || fromId !== teammateId) return;
      if (isReleaseMessage(text)) {
        clearManualState(beliefs, normalized.fromId ?? null, logger);
        return;
      }
      applyTeammateSyncMessage({
        rawText: normalized.text,
        fromId: normalized.fromId ?? null,
        beliefs,
        logger
      });
      return;
    }

    if (isTeammateRelease || isAdminRelease) {
      clearManualState(beliefs, normalized.fromId ?? null, logger);
      return;
    }

    if (!config?.llm?.chatEnabled) return;
    if (fromId === String(config.llm.adminId) || fromId === teammateId) {
      beliefs.pushChatMessage(normalized);
    }
  });
}
