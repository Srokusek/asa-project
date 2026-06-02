import { activeForbiddenTilesFromMissions, buildDeliveryRules } from "./delivery-rules.js";
import { createMissionSpec, MISSION_STATUS, missionIsActive, missionShouldExpire } from "./mission-spec.js";

export class MissionRegistry {
  constructor({ beliefs = null } = {}) {
    this.beliefs = beliefs;
    this.missions = new Map();
  }

  currentTick() {
    return Number(this.beliefs?.time ?? 0);
  }

  notify(action, mission, extra = {}) {
    this.beliefs?.pushEvent?.("MISSION_UPDATED", {
      action,
      missionId: mission?.id ?? null,
      type: mission?.type ?? null,
      status: mission?.status ?? null,
      ...extra
    });
    this.beliefs?.markDirty?.();
  }

  addMission(specInput = {}) {
    const spec = createMissionSpec({
      createdAtTick: this.currentTick(),
      ...specInput
    });
    if (spec.validationError) {
      this.notify("reject", spec, { reason: spec.validationError });
      return { ...spec, status: MISSION_STATUS.REJECTED };
    }
    this.missions.set(spec.id, spec);
    this.notify("add", spec);
    return { ...spec };
  }

  updateMission(id, patch = {}) {
    const key = String(id);
    const current = this.missions.get(key);
    if (!current) return null;
    const updated = createMissionSpec({
      ...current,
      ...patch,
      id: key,
      objective: patch.objective ? { ...current.objective, ...patch.objective } : current.objective,
      constraints: patch.constraints ?? current.constraints,
      rewardModifiers: patch.rewardModifiers ?? current.rewardModifiers
    });
    this.missions.set(key, updated);
    this.notify("update", updated);
    return { ...updated };
  }

  getMission(id) {
    const mission = this.missions.get(String(id));
    return mission ? { ...mission } : null;
  }

  activeMissions(currentTick = this.currentTick()) {
    this.expireMissions(currentTick);
    return [...this.missions.values()]
      .filter((mission) => missionIsActive(mission, currentTick))
      .map((mission) => ({ ...mission }));
  }

  activeDeliveryRules(currentTick = this.currentTick()) {
    return buildDeliveryRules(this.activeMissions(currentTick), currentTick);
  }

  activeLevel1(currentTick = this.currentTick()) {
    return this.activeMissions(currentTick).filter((mission) => Number(mission.level) === 1);
  }

  activeLevel2(currentTick = this.currentTick()) {
    return this.activeMissions(currentTick).filter((mission) => Number(mission.level) === 2);
  }

  activeLevel3(currentTick = this.currentTick()) {
    return this.activeMissions(currentTick).filter((mission) => Number(mission.level) === 3);
  }

  activeCoordinationPlans(currentTick = this.currentTick()) {
    return this.activeLevel3(currentTick)
      .map((mission) => mission.macroPlan ?? mission.objective?.coordinationPlan ?? null)
      .filter(Boolean);
  }

  activeForbiddenTiles(currentTick = this.currentTick()) {
    return activeForbiddenTilesFromMissions(this.activeMissions(currentTick), currentTick);
  }

  expireMissions(currentTick = this.currentTick()) {
    const expired = [];
    for (const [id, mission] of this.missions) {
      if (!missionShouldExpire(mission, currentTick)) continue;
      const updated = { ...mission, status: MISSION_STATUS.EXPIRED };
      this.missions.set(id, updated);
      expired.push(updated);
    }
    for (const mission of expired) {
      this.notify("expire", mission);
    }
    return expired.map((mission) => ({ ...mission }));
  }

  markCompleted(id) {
    return this.updateMission(id, { status: MISSION_STATUS.COMPLETED });
  }

  markAccepted(id) {
    return this.updateMission(id, { status: MISSION_STATUS.ACCEPTED });
  }

  markRejected(id, reason = "mission_rejected") {
    return this.updateMission(id, { status: MISSION_STATUS.REJECTED, reason });
  }

  markFailed(id, reason = "mission_failed") {
    return this.updateMission(id, { status: MISSION_STATUS.FAILED, reason });
  }

  markCancelled(id, reason = "mission_cancelled") {
    return this.updateMission(id, { status: MISSION_STATUS.CANCELLED, reason });
  }
}

export function createMissionRegistry(options = {}) {
  return new MissionRegistry(options);
}
