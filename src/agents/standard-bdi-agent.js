import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";
import { TEAM_MESSAGE_TYPES, createTeamMessage, serializeTeamMessage } from "../communication/team-protocol.js";
import { createPositionHeartbeatMessage, heartbeatDue } from "../communication/team-heartbeat.js";
import { buildAgentAliases, createMessageRouter } from "../communication/message-router.js";
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
    const { llm: _llm, ...runtimeConfig } = config;
    this.config = {
      ...runtimeConfig,
      agentRole: "bdi",
      agentName: runtimeConfig.agentName ?? "StandardBDIAgent"
    };
    this.logger = logger ?? createLogger(this.config.logLevel);
    this.socket = socket ?? connect(this.config.host, this.config.token, this.config.agentName);
    this.beliefs = new BeliefState(this.config);
    this.messageRouter = createMessageRouter({ role: "bdi" });
    this.teamMessageCursor = 0;
    this.lastHeartbeatTick = -Infinity;
    this.coordinationController = new CoordinationController({
      agentId: this.config.agentName,
      aliases: this.agentAliases(),
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
    if (spec.assignedTo && !this.agentAliases().includes(String(spec.assignedTo).trim().toLowerCase())) {
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
    this.coordinationController.setAliases(this.agentAliases());
    if (this.agentAliases().includes(String(message.from ?? "").trim().toLowerCase())) {
      return { accepted: false, reason: "self_message" };
    }
    if (message.type === TEAM_MESSAGE_TYPES.POSITION_HEARTBEAT) {
      const teammate = this.beliefs.updateTeamHeartbeat(message.payload, {
        receivedAtTick: this.beliefs.time,
        ttl: message.ttl,
        messageTick: message.tick
      });
      return { accepted: Boolean(teammate), type: message.type, teammate };
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
    return buildAgentAliases({ me: this.beliefs.me, config: this.config, role: "bdi" });
  }

  sendHeartbeatIfDue() {
    if (!this.beliefs.me || !heartbeatDue(this.lastHeartbeatTick, this.beliefs.time, this.config)) return false;
    const message = createPositionHeartbeatMessage({ beliefs: this.beliefs, config: this.config });
    if (!message) return false;
    this.lastHeartbeatTick = this.beliefs.time;
    void this.sendTeamMessage(message);
    return true;
  }

  processTeamInbox() {
    const aliases = this.agentAliases();
    this.coordinationController.setAliases(aliases);
    this.messageRouter.setAliases(aliases);
    const teamMessages = this.beliefs.teamMessages ?? [];
    for (const message of teamMessages.slice(this.teamMessageCursor)) {
      this.messageRouter.routeTeamMessage(message, this.beliefs.time);
    }
    this.teamMessageCursor = teamMessages.length;

    const messages = this.messageRouter.consumeTeamMessagesForAliases(aliases, this.beliefs.time);

    for (const message of messages) {
      this.handleTeamMessage(message);
    }
    this.sendHeartbeatIfDue();
  }

  start() {
    if (this.started) return;
    this.started = true;
    registerSdkListeners(this.socket, this.beliefs, this.loop, {
      messageRouter: this.messageRouter,
      routeNaturalChat: false,
      config: this.config
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
