import { readFile } from "node:fs/promises";
import { parseMap, replan, resetPlannerMemory, solveTick } from "./route_planner.js";

const raw = await readFile(new URL("./example_map.json", import.meta.url), "utf8");
const state = parseMap(JSON.parse(raw));

const result = replan(state);
const tick = solveTick(state);
const expectedSequence = ["START", "B", "C", "R_MAIN"];
const passesExpectedChoice =
  result.sequence.length === expectedSequence.length &&
  result.sequence.every((id, index) => id === expectedSequence[index]);

console.log("mode:", result.config.mode);
console.log("sequence:", result.sequence.join(" -> "));
console.log("value:", result.value);
console.log("path:", result.path.map((p) => `(${p.x},${p.y})`).join(" -> "));
console.log("next move:", tick.direction, tick.nextPosition);
console.log("expected B+C:", passesExpectedChoice ? "PASS" : "FAIL");

resetPlannerMemory();

if (!passesExpectedChoice) {
  process.exitCode = 1;
}
