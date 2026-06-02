import { CONFIG } from "../config.js";
import { hasTeamProtocolEnvelope, parseTeamMessage } from "../communication/team-protocol.js";

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

export function registerSdkListeners(socket, beliefs, _loop = null, options = {}) {
  const messageRouter = options.messageRouter ?? null;
  const routeNaturalChat = options.routeNaturalChat !== false;
  socket.on("connect", () => {
    beliefs.pushEvent("CONNECTED");
  });

  socket.on("disconnect", (reason) => {
    beliefs.pushEvent("DISCONNECTED", { reason });
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
      parcels: asArray(sensing.parcels),
      time: sensing.time
    });
  });

  socket.on("msg", (...args) => {
    const normalized = normalizeChatArgs(args);
    const teamMessage = parseTeamMessage(normalized.text);
    if (teamMessage || hasTeamProtocolEnvelope(normalized.text)) {
      const routed = messageRouter?.routeTeamMessage?.(teamMessage ?? normalized.text, beliefs.time);
      if ((!messageRouter && teamMessage) || routed?.kind === "team") {
        const message = routed?.message ?? teamMessage;
        beliefs.pushTeamMessage({
          ...message,
          from: message.from ?? normalized.fromId ?? null,
          rawFromId: normalized.fromId ?? null
        });
      }
      return;
    }
    if (routeNaturalChat) messageRouter?.routeIncomingChat?.(normalized, beliefs.time);
    // ignore non-admin messages
    if (CONFIG.adminId) {
      if (String(normalized.fromId ?? "") !== String(CONFIG.adminId)) return;
    }
    beliefs.pushChatMessage(normalized);
  });
}
