import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";
import { buildAgentAliases, createMessageRouter } from "../communication/message-router.js";
import { TEAM_MESSAGE_TYPES, createTeamMessage, hasTeamProtocolEnvelope, parseTeamMessage, serializeTeamMessage } from "../communication/team-protocol.js";
import { createPositionHeartbeatMessage, heartbeatDue } from "../communication/team-heartbeat.js";
import { CoordinationController } from "../coordination/coordination-controller.js";
import { AgentLoop } from "../control/agent-loop.js";
import { createLlmClient } from "../llm/llm-client.js";
import { buildMissionPrompt } from "../llm/mission-prompt.js";
import { parseLlmMissionOutput, parseMissionSpecPayload, parseSimpleMissionText } from "../missions/mission-parser.js";
import { createMissionSpec, MISSION_TYPES, validateMissionSpec } from "../missions/mission-spec.js";
import { BeliefState } from "../state/belief-state.js";
import { registerSdkListeners } from "../state/sdk-adapter.js";
import { createLogger } from "../utils/logger.js";

const VALID_TEAM_MESSAGE_TYPES = new Set(Object.values(TEAM_MESSAGE_TYPES));

function targetFrom(spec) {
  return spec?.objective?.target ?? spec?.target ?? null;
}

function compactPosition(position) {
  if (!position) return null;
  const x = Math.round(Number(position.x ?? position.position?.x));
  const y = Math.round(Number(position.y ?? position.position?.y));
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function tileType(tile) {
  return String(tile && typeof tile === "object" ? tile.type ?? "0" : tile ?? "0");
}

function compactMission(mission) {
  return {
    id: mission.id,
    type: mission.type,
    level: mission.level,
    status: mission.status,
    assignedTo: mission.assignedTo ?? null,
    objective: mission.objective ?? {},
    reason: mission.reason ?? null
  };
}

function parcelAt(beliefs, position) {
  for (const parcel of beliefs.parcels?.values?.() ?? []) {
    if (parcel.carriedBy) continue;
    if (Math.round(Number(parcel.x)) !== position.x || Math.round(Number(parcel.y)) !== position.y) continue;
    if (Number(parcel.confidence ?? 0) <= 0) continue;
    return parcel;
  }
  return null;
}

function summarizeRedGreen(beliefs) {
  const reds = [];
  const greens = [];
  for (const tile of beliefs.tiles?.values?.() ?? []) {
    const position = compactPosition(tile);
    if (!position) continue;
    const type = tileType(tile);
    if (type === "2") {
      reds.push(position);
    } else if (type === "1") {
      const parcel = parcelAt(beliefs, position);
      greens.push({
        position,
        hasParcel: Boolean(parcel),
        reward: parcel ? Number(parcel.reward ?? parcel.rewardAtLastSeen ?? 0) : null
      });
    }
  }
  return {
    reds: { count: reds.length, sample: reds.slice(0, 8) },
    greens: { count: greens.length, withParcelCount: greens.filter((green) => green.hasParcel).length, sample: greens.slice(0, 8) }
  };
}

function normalizeChatArgs(args) {
  if (args.length === 1 && typeof args[0] === "object") {
    const message = args[0];
    return {
      fromId: message.fromId ?? message.id ?? message.from ?? null,
      fromName: message.fromName ?? message.name ?? null,
      text: String(message.text ?? message.msg ?? message.message ?? "")
    };
  }
  if (args.length >= 3) {
    const [fromId, fromName, msg] = args;
    return { fromId, fromName, text: String(msg ?? "") };
  }
  if (args.length === 2) {
    const [fromId, msg] = args;
    return { fromId, text: String(msg ?? "") };
  }
  return { text: String(args[0] ?? "") };
}

export class CoordinationBDIAgent {
  constructor(config, { socket = null, connect = DjsConnect, logger = null, llmClient = null } = {}) {
    this.config = {
      ...config,
      agentRole: "llm",
      agentName: config.agentName ?? "CoordinationBDIAgent"
    };
    this.logger = logger ?? createLogger(this.config.logLevel);
    this.socket = socket ?? connect(this.config.host, this.config.token, this.config.agentName);
    this.beliefs = new BeliefState(this.config);
    this.messageRouter = createMessageRouter({ role: "llm" });
    this.llmClient = llmClient ?? createLlmClient({ llm: this.config.llm });
    this.missionsSent = new Map();
    this.plansSent = new Map();
    this.teamMessageCursor = 0;
    this.lastHeartbeatTick = -Infinity;
    this.inFlight = false;
    this.sidecarTimer = null;
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
      return await this.socket.emitShout(serialized);
    } catch (error) {
      this.logger.warn("team message send failed", { error: error.message, type: message.type });
      return false;
    }
  }

  async translateChat(message) {
    const fallback = parseSimpleMissionText(message.text, {
      sourceAgentId: message.fromId,
      createdAtTick: this.beliefs.time,
      createdBy: this.config.agentName
    });
    if (!this.config.llm?.apiKey && !this.llmClient?.isMock) return fallback ? { missionSpecs: [fallback] } : { unsupported: true };

    const prompt = buildMissionPrompt(message, this.buildLlmContext());
    const parseOptions = this.llmParserOptions(message);
    const first = await this.llmClient.call(prompt, { toolChoice: "none", temperature: 0 });
    let parsed = parseLlmMissionOutput(first.message?.content ?? first.message, parseOptions);
    if (!parsed.ok && parsed.reason === "invalid_json") {
      const retry = await this.llmClient.call([
        ...prompt,
        { role: "user", content: "Previous output was invalid JSON. Return only valid structured JSON." }
      ], { toolChoice: "none", temperature: 0 });
      parsed = parseLlmMissionOutput(retry.message?.content ?? retry.message, parseOptions);
    }
    if (!parsed.ok) {
      return {
        unsupported: true,
        reason: parsed.reason === "invalid_json" ? "invalid_llm_output" : parsed.reason
      };
    }
    for (const warning of parsed.value.warnings ?? []) {
      this.logger.warn("LLM structured output warning", warning);
    }
    return parsed.value;
  }

  llmRoleAliases() {
    return {
      "coordination-agent": this.agentAliases(),
      "standard-bdi-agent": [
        "standard-bdi-agent",
        "bdi-agent",
        "bdi",
        this.config.team?.peerName,
        this.config.team?.bdiAgentName
      ].filter(Boolean)
    };
  }

  llmParserOptions(message = null) {
    return {
      roleAliases: this.llmRoleAliases(),
      meta: {
        sourceAgentId: message?.fromId,
        createdBy: this.config.agentName,
        createdAtTick: this.beliefs.time
      }
    };
  }

  buildLlmContext() {
    const team = this.coordinationController.teamSummary(this.beliefs.time);
    const rules = this.beliefs.missionRegistry?.activeDeliveryRules?.(this.beliefs.time) ?? {};
    return {
      own: {
        agentId: this.beliefs.me?.id ?? null,
        agentName: this.beliefs.me?.name ?? this.config.agentName,
        role: this.config.agentRole,
        position: compactPosition(this.beliefs.me),
        carriedCount: this.beliefs.carriedParcels?.size ?? 0,
        aliases: this.agentAliases()
      },
      team,
      activeMissions: (this.beliefs.missionRegistry?.activeMissions?.(this.beliefs.time) ?? [])
        .slice(0, 8)
        .map(compactMission),
      mapSummary: summarizeRedGreen(this.beliefs),
      activeConstraints: {
        redLight: Boolean(this.coordinationController.redLight),
        stackRules: rules.stackRules ?? [],
        stackRuleConflicts: rules.stackRuleConflicts ?? [],
        forbiddenDeliveryCounts: rules.forbiddenDeliveryCounts ?? [],
        parcelValueFilters: rules.parcelValueFilters ?? [],
        forbiddenTiles: this.beliefs.listForbiddenTiles?.().slice(0, 8) ?? []
      },
      supportedMissionTypes: Object.values(MISSION_TYPES),
      supportedCoordinationTypes: [
        MISSION_TYPES.RENDEZVOUS,
        MISSION_TYPES.BOTH_NEAR_POSITION,
        MISSION_TYPES.COORDINATED_WAIT,
        MISSION_TYPES.RED_LIGHT_GREEN_LIGHT,
        MISSION_TYPES.HANDOFF
      ],
      supportedTeamMessageTypes: Object.values(TEAM_MESSAGE_TYPES)
    };
  }

  async publishStructuredOutput(output, sourceMessage = null) {
    if (output?.unsupported) {
      const reason = output.reason ?? "unsupported";
      this.logger.info("LLM request unsupported", { reason });
      await this.reply(TEAM_MESSAGE_TYPES.MISSION_REJECTED, sourceMessage?.fromId ?? null, {
        missionId: output.missionId ?? sourceMessage?.missionId ?? null,
        sourceChatId: sourceMessage?.chatId ?? null,
        reason
      });
      return;
    }
    if (output?.clarification) {
      await this.reply(TEAM_MESSAGE_TYPES.STATUS_UPDATE, sourceMessage?.fromId ?? null, {
        status: "CLARIFICATION_REQUESTED",
        sourceChatId: sourceMessage?.chatId ?? null,
        reason: String(output.clarification)
      });
      return;
    }
    for (const rejected of output.rejectedMissionSpecs ?? []) {
      await this.reply(TEAM_MESSAGE_TYPES.MISSION_REJECTED, sourceMessage?.fromId ?? null, {
        missionId: rejected.spec?.id ?? null,
        reason: rejected.reason ?? "invalid_mission_spec"
      });
    }

    for (const spec of output.missionSpecs ?? []) {
      const parsed = parseMissionSpecPayload(spec, {
        sourceAgentId: sourceMessage?.fromId,
        createdBy: this.config.agentName,
        createdAtTick: this.beliefs.time
      });
      const validation = parsed ? validateMissionSpec(parsed) : { ok: false, reason: "invalid_mission_spec" };
      if (!parsed || parsed.validationError || !validation.ok) {
        const reason = parsed?.validationError ?? validation.reason ?? "invalid_mission_spec";
        this.logger.warn("LLM MissionSpec rejected", { reason, type: spec?.type ?? parsed?.type ?? null });
        await this.reply(TEAM_MESSAGE_TYPES.MISSION_REJECTED, sourceMessage?.fromId ?? null, {
          missionId: parsed?.id ?? spec?.id ?? null,
          reason
        });
        continue;
      }
      const added = this.beliefs.missionRegistry.addMission(parsed);
      this.missionsSent.set(added.id, added);
      if (added.assignedTo && this.agentAliases().includes(String(added.assignedTo).trim().toLowerCase())) {
        this.acceptMission(added, sourceMessage?.fromId ?? null);
      }
      await this.sendTeamMessage(createTeamMessage(
        TEAM_MESSAGE_TYPES.MISSION_SPEC,
        this.config.agentName,
        added.assignedTo ?? null,
        { missionSpec: added },
        { tick: this.beliefs.time, ttl: 80 }
      ));
    }

    for (const plan of output.coordinationPlans ?? []) {
      if (!plan?.id) continue;
      this.plansSent.set(plan.id, plan);
      this.coordinationController.setAliases(this.agentAliases());
      this.coordinationController.receiveCoordinationPlan(plan, sourceMessage?.fromId ?? null, {
        ttl: Number(plan.ttl ?? plan.expiresTicks ?? 80),
        tick: this.beliefs.time
      });
      await this.sendTeamMessage(createTeamMessage(
        TEAM_MESSAGE_TYPES.COORDINATION_PLAN,
        this.config.agentName,
        null,
        { coordinationPlan: plan },
        { tick: this.beliefs.time, ttl: 80 }
      ));
    }

    for (const assignment of output.subgoalAssignments ?? []) {
      try {
        await this.sendTeamMessage(createTeamMessage(
          TEAM_MESSAGE_TYPES.SUBGOAL_ASSIGNMENT,
          this.config.agentName,
          assignment.to ?? null,
          { subgoal: assignment.subgoal },
          { tick: this.beliefs.time, ttl: 60 }
        ));
      } catch (error) {
        this.logger.warn("LLM subgoal assignment discarded", { error: error.message });
      }
    }

    for (const message of output.teamMessages ?? []) {
      const type = TEAM_MESSAGE_TYPES[String(message.type ?? "").trim().toUpperCase()] ?? String(message.type ?? "").trim().toUpperCase();
      if (!VALID_TEAM_MESSAGE_TYPES.has(type)) {
        this.logger.warn("LLM teamMessage discarded", { reason: "invalid_team_message_type", type: message.type });
        continue;
      }
      try {
        await this.sendTeamMessage(createTeamMessage(
          type,
          this.config.agentName,
          message.to ?? null,
          message.payload ?? {},
          { tick: this.beliefs.time, ttl: Number(message.ttl ?? 30) }
        ));
      } catch (error) {
        this.logger.warn("LLM teamMessage discarded", { reason: error.message, type });
      }
    }
  }

  kickSidecar() {
    if (this.inFlight) return false;
    const [message] = this.messageRouter.consumeMissionMessages();
    if (!message) return false;
    this.inFlight = true;
    void this.translateChat(message)
      .then((output) => this.publishStructuredOutput(output, message))
      .catch((error) => {
        this.logger.warn("LLM sidecar failed", { error: error.message });
      })
      .finally(() => {
        this.inFlight = false;
      });
    return true;
  }

  reply(type, to, payload = {}, ttl = 30) {
    return this.sendTeamMessage(createTeamMessage(type, this.config.agentName, to ?? null, payload, {
      tick: this.beliefs.time,
      ttl
    }));
  }

  agentAliases() {
    return buildAgentAliases({ me: this.beliefs.me, config: this.config, role: "llm" });
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

  processTeamInbox() {
    const aliases = this.agentAliases();
    this.coordinationController.setAliases(aliases);
    this.messageRouter.setAliases(aliases);
    const teamMessages = this.beliefs.teamMessages ?? [];
    for (const message of teamMessages.slice(this.teamMessageCursor)) {
      this.messageRouter.routeTeamMessage(message, this.beliefs.time);
    }
    this.teamMessageCursor = teamMessages.length;

    const handled = this.messageRouter.consumeTeamMessagesForAliases(aliases, this.beliefs.time);
    for (const message of handled) {
      this.handleTeamMessage(message);
    }

    for (const reply of this.messageRouter.consumeTeamReplies(this.beliefs.time)) {
      if (aliases.includes(String(reply.from ?? "").trim().toLowerCase())) continue;
      this.coordinationController.receiveTeamMessage(reply);
      this.logger.info("team reply received", {
        type: reply.type,
        from: reply.from,
        missionId: reply.payload?.missionId ?? null
      });
    }
    this.sendHeartbeatIfDue();
  }

  processTeamReplies() {
    return this.processTeamInbox();
  }

  sendHeartbeatIfDue() {
    if (!this.beliefs.me || !heartbeatDue(this.lastHeartbeatTick, this.beliefs.time, this.config)) return false;
    const message = createPositionHeartbeatMessage({ beliefs: this.beliefs, config: this.config });
    if (!message) return false;
    this.lastHeartbeatTick = this.beliefs.time;
    void this.sendTeamMessage(message);
    return true;
  }

  registerNaturalChatListener() {
    this.socket.on("msg", (...args) => {
      const normalized = normalizeChatArgs(args);
      if (parseTeamMessage(normalized.text) || hasTeamProtocolEnvelope(normalized.text)) return;
      if (normalized.fromId && this.beliefs.me?.id && String(normalized.fromId) === String(this.beliefs.me.id)) return;
      this.kickSidecar();
    });
  }

  start() {
    if (this.started) return;
    this.started = true;
    registerSdkListeners(this.socket, this.beliefs, this.loop, { messageRouter: this.messageRouter, config: this.config });
    this.registerNaturalChatListener();
    this.sidecarTimer = setInterval(() => this.kickSidecar(), 100);
    this.socket.on("connect", () => {
      this.logger.info("connected CoordinationBDIAgent");
      this.loop.start();
    });
    this.socket.on("disconnect", (reason) => {
      this.logger.warn("CoordinationBDIAgent disconnected", reason);
      this.loop.stop();
    });
    if (this.socket.connected) this.loop.start();
  }

  stop() {
    if (this.sidecarTimer) clearInterval(this.sidecarTimer);
    this.sidecarTimer = null;
    this.loop.stop();
    this.socket.disconnect?.();
    this.started = false;
  }
}

export { CoordinationBDIAgent as LlmCoordinationAgent };

export function createCoordinationBDIAgent(config, options = {}) {
  return new CoordinationBDIAgent(config, options);
}

export function createLlmCoordinationAgent(config, options = {}) {
  return createCoordinationBDIAgent(config, options);
}
