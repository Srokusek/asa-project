import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TUNABLE_PARAMS } from "../src/config/tunable-params.js";
import { Telemetry } from "../src/telemetry/telemetry.js";
import { defaultBenchmarkCases, runBenchmarks } from "../scripts/benchmark-local.js";
import { randomParamSearch } from "../scripts/random-param-search.js";

test("telemetry writes JSONL records with counters and compact actions", () => {
  const dir = mkdtempSync(join(tmpdir(), "deliveroo-telemetry-"));
  const file = join(dir, "telemetry.jsonl");

  try {
    const telemetry = new Telemetry({ telemetry: { enabled: true, file } });
    telemetry.nextTick();
    telemetry.record("replan", {
      mode: "SCOUT",
      currentPosition: { x: 0, y: 0 },
      sequence: ["START", "SCOUT_G"],
      expectedValue: 1.5,
      parcelsInBelief: 0,
      greensWithPackage: 0,
      carriedCount: 0,
      planningTimeMs: 2,
      temporaryBlockedCells: 1,
      scoutTarget: "G",
      candidateCount: 0
    });
    telemetry.record("move_failed", {
      mode: "SCOUT",
      action: {
        type: "move",
        direction: "right",
        from: { x: 0, y: 0 },
        to: { x: 1, y: 0 },
        ignoredLargeField: "not exported"
      },
      result: false
    });

    assert.equal(existsSync(file), true);
    const lines = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));

    assert.equal(lines.length, 2);
    assert.equal(lines[0].event, "replan");
    assert.equal(lines[0].replanCount, 1);
    assert.equal(lines[1].event, "move_failed");
    assert.equal(lines[1].moveFailedCount, 1);
    assert.deepEqual(lines[1].action, {
      type: "move",
      direction: "right",
      from: { x: 0, y: 0 },
      to: { x: 1, y: 0 }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("disabled telemetry still maintains in-memory counters without writing a file", () => {
  const dir = mkdtempSync(join(tmpdir(), "deliveroo-telemetry-disabled-"));
  const file = join(dir, "telemetry.jsonl");

  try {
    const telemetry = new Telemetry({ telemetry: { enabled: false, file } });
    telemetry.record("pickup_failed");
    telemetry.record("putdown_failed");

    assert.equal(telemetry.counters.pickupFailed, 1);
    assert.equal(telemetry.counters.putdownFailed, 1);
    assert.equal(existsSync(file), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("benchmark runner covers required offline planner scenarios", () => {
  const results = runBenchmarks(defaultBenchmarkCases());
  const failed = results.filter((result) => !result.passed);

  assert.equal(failed.length, 0, JSON.stringify(failed, null, 2));
  assert.ok(results.some((result) => result.name === "no parcels visible, greens known" && result.mode === "SCOUT"));
  assert.ok(results.some((result) => result.name === "parcel visible" && result.mode === "PICKUP_DELIVERY"));
  assert.ok(results.some((result) => result.name === "carried parcel" && result.mode === "DELIVERY_ONLY"));
});

test("random parameter search exposes tuning hooks without RL state learning", () => {
  const best = randomParamSearch({
    cases: defaultBenchmarkCases().slice(0, 3),
    trials: 2,
    ranges: {
      moveWeight: [1, 1],
      betaCarry: [1, 1],
      kWin: [1, 1],
      rhoGeneration: [0.1, 0.1],
      targetCongestionPenalty: [0, 0],
      scoutCooldownTicks: [8, 8],
      recentScoutPenalty: [15, 15],
      sameScoutTargetPenalty: [20, 20],
      deliveryUrgencyWeight: [0, 0],
      beamWidth: [20, 20],
      topK: [8, 8],
      maxPickupsBeforeDelivery: [2, 2]
    }
  });

  assert.ok(best);
  assert.equal(best.params.moveWeight, 1);
  assert.equal(best.params.maxPickupsBeforeDelivery, 2);
  assert.equal(Number.isFinite(best.scoreMean), true);
  assert.equal(Number.isFinite(best.scoreMin), true);
  assert.equal(Number.isFinite(best.planningTimeMsMean), true);
});

test("tunable parameter registry contains the expected competitive knobs", () => {
  assert.deepEqual(
    TUNABLE_PARAMS,
    [
      "moveWeight",
      "betaCarry",
      "kWin",
      "rhoGeneration",
      "targetCongestionPenalty",
      "scoutCooldownTicks",
      "recentScoutPenalty",
      "sameScoutTargetPenalty",
      "deliveryUrgencyWeight",
      "clusterPickupRadius",
      "clusterPickupBonusWeight",
      "minClusterPackageValue",
      "infoValueWeight",
      "maxStalenessValue",
      "greenInfoMultiplier",
      "emptyGreenFutureWeight",
      "greenClusterDistance",
      "clusterSizeWeight",
      "explorationDebtThreshold",
      "explorationDebtBonus",
      "opportunisticMaxDistance",
      "opportunisticPathRadius",
      "opportunisticMinGain",
      "opportunisticCongestionPenalty",
      "beamWidth",
      "topK",
      "maxPickupsBeforeDelivery"
    ]
  );
});
