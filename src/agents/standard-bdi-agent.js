import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";
import { TEAM_MESSAGE_TYPES, createTeamMessage, serializeTeamMessage } from "../communication/team-protocol.js";
import { createMessageRouter } from "../communication/message-router.js";
import { CoordinationController } from "../coordination/coordination-controller.js";
import { AgentLoop } from "../control/agent-loop.js";
import { createMissionSpec, validateMissionSpec, MISSION_TYPES } from "../missions/mission-spec.js";
import { BeliefState } from "../state/belief-state.js";
import { registerSdkListeners } from "../state/sdk-adapter.js";
import { createLogger } from "../utils/logger.js";

function targetFrom(spec) {
  return spec?.objective?.target ?? spec?.target ?? null;
}

export class StandardBDIAgent {
  constructor(config, { socket = null, connect = DjsConnect, logger = null } = {}) {
    this.config = {
      ...config,
      agentRole: "bdi",
      agentName: process.env.BDI_AGENT_NAME ?? config.agentName ?? "StandardBDIAgent"
    };
    this.logger = logger ?? createLogger(this.config.logLevel);
    this.socket = socket ?? connect(this.config.host, this.config.token, this.config.agentName);
    this.beliefs = new BeliefState(this.config);
    this.messageRouter = createMessageRouter({ role: "bdi" });
    this.teamMessageCursor = 0;
    this.coordinationController = new CoordinationController({
      agentId: this.config.agentName,
      beliefs: this.beliefs,
      missionRegistry: this.beliefs.missionRegistry,
      sendTeamMessage: (message) => {
        void this.sendTeamMessage(message);
      }
    });
    this.loop = new AgentLoop(this.socket, this.beliefs, this.config, {
      enableChatProcessor: false,
      coordinationController: this.coordinationController,
      teamMessageHandler: () => this.processTeamInbox()
    });
    this.started = false;
  }

  async sendTeamMessage(message) {
    const serialized = serializeTeamMessage(message);
    try {
      if (message.to) return await this.socket.emitShout(serialized);
      return await this.socket.emitShout(serialized);
    } catch (error) {
      this.logger.warn("team message send failed", { error: error.message, type: message.type });
      return false;
    }
  }

  reply(type, to, payload = {}, ttl = 30) {
    return this.sendTeamMessage(createTeamMessage(type, this.config.agentName, to ?? null, payload, {
      tick: this.beliefs.time,
      ttl
    }));
  }

  acceptMission(spec, from = null) {
    const accepted = this.beliefs.missionRegistry.markAccepted(spec.id) ?? this.beliefs.missionRegistry.getMission(spec.id);
    if (spec.type === MISSION_TYPES.GOTO_TILE) {
      const target = targetFrom(spec);
      if (target) {
        this.beliefs.pushManualTask({
          type: "goto_tile",
          sourceChatId: spec.sourceChatId,
          senderId: from,
          expiresTicks: 80,
          priority: "sticky_until_done",
          payload: {
            target,
            reason: spec.reason,
            goalType: "goto_tile",
            missionId: spec.id
          }
        });
      }
    }
    void this.reply(TEAM_MESSAGE_TYPES.MISSION_ACCEPTED, from, {
      missionId: spec.id,
      status: accepted?.status ?? "ACCEPTED"
    });
    return accepted;
  }

  rejectMission(spec, from, reason) {
    this.beliefs.missionRegistry.markRejected(spec.id, reason);
    void this.reply(TEAM_MESSAGE_TYPES.MISSION_REJECTED, from, {
      missionId: spec.id,
      reason
    });
  }

  handleMissionSpec(rawSpec, from = null) {
    const spec = createMissionSpec({
      ...rawSpec,
      sourceAgentId: rawSpec?.sourceAgentId ?? from,
      createdAtTick: this.beliefs.time
    });
    const validation = validateMissionSpec(spec);
    if (!validation.ok || spec.validationError) {
      this.rejectMission(spec, from, spec.validationError ?? validation.reason);
      return { accepted: false, reason: spec.validationError ?? validation.reason };
    }
    if (spec.assignedTo && !this.agentAliases().includes(String(spec.assignedTo))) {
      this.rejectMission(spec, from, "mission_assigned_to_other_agent");
      return { accepted: false, reason: "mission_assigned_to_other_agent" };
    }

    const added = this.beliefs.missionRegistry.addMission(spec);
    if (Number(added.level) === 3 && (added.macroPlan || added.objective?.coordinationPlan)) {
      this.coordinationController.receiveCoordinationPlan(added.macroPlan ?? added.objective.coordinationPlan, from);
    }
    this.acceptMission(added, from);
    return { accepted: true, mission: added };
  }

  handleTeamMessage(message) {
    if (this.agentAliases().includes(String(message.from ?? ""))) {
      return { accepted: false, reason: "self_message" };
    }
    if (message.type === TEAM_MESSAGE_TYPES.MISSION_SPEC) {
      return this.handleMissionSpec(message.payload?.missionSpec ?? message.payload, message.from);
    }
    if (message.type === TEAM_MESSAGE_TYPES.MISSION_CANCEL) {
      const id = message.payload?.missionId ?? message.payload?.id;
      if (id) this.beliefs.missionRegistry.markCancelled(id, "cancelled_by_team_protocol");
      return { accepted: true, type: message.type };
    }
    const coordination = this.coordinationController.receiveTeamMessage(message);
    if (coordination) return coordination;
    return { accepted: false, reason: "unsupported_team_message" };
  }

  agentAliases() {
    return [...new Set([this.beliefs.me?.id, this.config.agentName].filter(Boolean).map(String))];
  }

  processTeamInbox() {
    this.messageRouter.setSelfId(this.beliefs.me?.id ?? this.config.agentName);
    const teamMessages = this.beliefs.teamMessages ?? [];
    for (const message of teamMessages.slice(this.teamMessageCursor)) {
      this.messageRouter.routeTeamMessage(message, this.beliefs.time);
    }
    this.teamMessageCursor = teamMessages.length;

    const messages = [];
    const seen = new Set();
    for (const alias of this.agentAliases()) {
      for (const message of this.messageRouter.consumeTeamMessagesFor(alias, this.beliefs.time)) {
        if (seen.has(message.id)) continue;
        if (this.agentAliases().includes(String(message.from ?? ""))) continue;
        seen.add(message.id);
        messages.push(message);
      }
    }

    for (const message of messages) {
      this.handleTeamMessage(message);
    }
  }

  start() {
    if (this.started) return;
    this.started = true;
    registerSdkListeners(this.socket, this.beliefs, this.loop, {
      messageRouter: this.messageRouter,
      routeNaturalChat: false
    });
    this.socket.on("connect", () => {
      this.logger.info("connected StandardBDIAgent");
      this.loop.start();
    });
    this.socket.on("disconnect", (reason) => {
      this.logger.warn("StandardBDIAgent disconnected", reason);
      this.loop.stop();
    });
    if (this.socket.connected) this.loop.start();
  }

  stop() {
    this.loop.stop();
    this.socket.disconnect?.();
    this.started = false;
  }
}

export function createStandardBDIAgent(config, options = {}) {
  return new StandardBDIAgent(config, options);
}
