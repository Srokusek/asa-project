import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";
import { createMessageRouter } from "../communication/message-router.js";
import { TEAM_MESSAGE_TYPES, createTeamMessage, parseTeamMessage, serializeTeamMessage } from "../communication/team-protocol.js";
import { CoordinationController } from "../coordination/coordination-controller.js";
import { AgentLoop } from "../control/agent-loop.js";
import { createLlmClient } from "../llm/llm-client.js";
import { buildMissionPrompt } from "../llm/mission-prompt.js";
import { parseLlmMissionOutput, parseMissionSpecPayload, parseSimpleMissionText } from "../missions/mission-parser.js";
import { createMissionSpec, MISSION_TYPES, validateMissionSpec } from "../missions/mission-spec.js";
import { BeliefState } from "../state/belief-state.js";
import { registerSdkListeners } from "../state/sdk-adapter.js";
import { createLogger } from "../utils/logger.js";

function targetFrom(spec) {
  return spec?.objective?.target ?? spec?.target ?? null;
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

export class LlmCoordinationAgent {
  constructor(config, { socket = null, connect = DjsConnect, logger = null, llmClient = null } = {}) {
    this.config = {
      ...config,
      agentRole: "llm",
      agentName: process.env.LLM_AGENT_NAME ?? `${config.agentName ?? "CoordinationBDIAgent"}-LLM`
    };
    this.logger = logger ?? createLogger(this.config.logLevel);
    this.socket = socket ?? connect(this.config.host, this.config.token, this.config.agentName);
    this.beliefs = new BeliefState(this.config);
    this.messageRouter = createMessageRouter({ role: "llm" });
    this.llmClient = llmClient ?? createLlmClient();
    this.missionsSent = new Map();
    this.plansSent = new Map();
    this.teamMessageCursor = 0;
    this.inFlight = false;
    this.sidecarTimer = null;
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
    if (!process.env.LITELLM_API_KEY && !this.llmClient?.isMock) return fallback ? { missionSpecs: [fallback] } : { unsupported: true };

    const prompt = buildMissionPrompt(message, {
      agentId: this.config.agentName,
      tick: this.beliefs.time
    });
    const first = await this.llmClient.call(prompt, { toolChoice: "none", temperature: 0 });
    let parsed = parseLlmMissionOutput(first.message?.content ?? first.message);
    if (!parsed.ok) {
      const retry = await this.llmClient.call([
        ...prompt,
        { role: "user", content: "Previous output was invalid JSON. Return only valid structured JSON." }
      ], { toolChoice: "none", temperature: 0 });
      parsed = parseLlmMissionOutput(retry.message?.content ?? retry.message);
    }
    if (!parsed.ok) return fallback ? { missionSpecs: [fallback] } : { unsupported: true, reason: parsed.reason };
    return parsed.value;
  }

  async publishStructuredOutput(output, sourceMessage = null) {
    for (const spec of output.missionSpecs ?? []) {
      const parsed = parseMissionSpecPayload(spec, {
        sourceAgentId: sourceMessage?.fromId,
        createdBy: this.config.agentName,
        createdAtTick: this.beliefs.time
      });
      if (!parsed || parsed.validationError) continue;
      const added = this.beliefs.missionRegistry.addMission(parsed);
      this.missionsSent.set(added.id, added);
      if (added.assignedTo && this.agentAliases().includes(String(added.assignedTo))) {
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
      await this.sendTeamMessage(createTeamMessage(
        TEAM_MESSAGE_TYPES.COORDINATION_PLAN,
        this.config.agentName,
        null,
        { coordinationPlan: plan },
        { tick: this.beliefs.time, ttl: 80 }
      ));
    }

    for (const assignment of output.subgoalAssignments ?? []) {
      await this.sendTeamMessage(createTeamMessage(
        TEAM_MESSAGE_TYPES.SUBGOAL_ASSIGNMENT,
        this.config.agentName,
        assignment.to ?? null,
        { subgoal: assignment.subgoal },
        { tick: this.beliefs.time, ttl: 60 }
      ));
    }

    for (const message of output.teamMessages ?? []) {
      await this.sendTeamMessage(createTeamMessage(
        message.type,
        this.config.agentName,
        message.to ?? null,
        message.payload ?? {},
        { tick: this.beliefs.time, ttl: Number(message.ttl ?? 30) }
      ));
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
    return [...new Set([this.beliefs.me?.id, this.config.agentName].filter(Boolean).map(String))];
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

  processTeamInbox() {
    this.messageRouter.setSelfId(this.beliefs.me?.id ?? this.config.agentName);
    const teamMessages = this.beliefs.teamMessages ?? [];
    for (const message of teamMessages.slice(this.teamMessageCursor)) {
      this.messageRouter.routeTeamMessage(message, this.beliefs.time);
    }
    this.teamMessageCursor = teamMessages.length;

    const handled = [];
    const seen = new Set();
    for (const alias of this.agentAliases()) {
      for (const message of this.messageRouter.consumeTeamMessagesFor(alias, this.beliefs.time)) {
        if (seen.has(message.id)) continue;
        if (this.agentAliases().includes(String(message.from ?? ""))) continue;
        seen.add(message.id);
        handled.push(message);
      }
    }
    for (const message of handled) {
      this.handleTeamMessage(message);
    }

    for (const reply of this.messageRouter.consumeTeamReplies(this.beliefs.time)) {
      if (this.agentAliases().includes(String(reply.from ?? ""))) continue;
      this.logger.info("team reply received", {
        type: reply.type,
        from: reply.from,
        missionId: reply.payload?.missionId ?? null
      });
    }
  }

  processTeamReplies() {
    return this.processTeamInbox();
  }

  registerNaturalChatListener() {
    this.socket.on("msg", (...args) => {
      const normalized = normalizeChatArgs(args);
      if (parseTeamMessage(normalized.text)) return;
      if (normalized.fromId && this.beliefs.me?.id && String(normalized.fromId) === String(this.beliefs.me.id)) return;
      this.kickSidecar();
    });
  }

  start() {
    if (this.started) return;
    this.started = true;
    registerSdkListeners(this.socket, this.beliefs, this.loop, { messageRouter: this.messageRouter });
    this.registerNaturalChatListener();
    this.sidecarTimer = setInterval(() => this.kickSidecar(), 100);
    this.socket.on("connect", () => {
      this.logger.info("connected LlmCoordinationAgent");
      this.loop.start();
    });
    this.socket.on("disconnect", (reason) => {
      this.logger.warn("LlmCoordinationAgent disconnected", reason);
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

export function createLlmCoordinationAgent(config, options = {}) {
  return new LlmCoordinationAgent(config, options);
}
