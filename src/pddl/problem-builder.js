import { readFile } from "node:fs/promises";

const TEMPLATE_URL = new URL("./test_problem.pddl", import.meta.url);
const START_MARKER = "    ; BEGIN GENERATED HAS_VISITED GOALS";
const END_MARKER = "    ; END GENERATED HAS_VISITED GOALS";
const SOURCE_FLOWS = ["source1", "source2"];
const VALID_SECTORS = new Set(["l1", "l2", "l3"]);

function normalizeSectors(sectors, name) {
  if (!Array.isArray(sectors)) {
    throw new Error(`${name} must be an array`);
  }

  const normalized = [];
  const seen = new Set();

  for (const sector of sectors) {
    if (!VALID_SECTORS.has(sector)) {
      throw new Error(`${name} contains unknown sector: ${String(sector)}`);
    }
    if (!seen.has(sector)) {
      seen.add(sector);
      normalized.push(sector);
    }
  }

  return normalized;
}

function buildVisitGoals(requiredSectors, forbiddenSectors) {
  const goals = [];

  for (const source of SOURCE_FLOWS) {
    for (const sector of requiredSectors) {
      goals.push(`    (has_visited ${source} ${sector})`);
    }
    for (const sector of forbiddenSectors) {
      goals.push(`    (not (has_visited ${source} ${sector}))`);
    }
  }

  return goals.join("\n");
}

export async function buildPddlProblem({
  requiredSectors = [],
  forbiddenSectors = []
} = {}) {
  const required = normalizeSectors(requiredSectors, "requiredSectors");
  const forbidden = normalizeSectors(forbiddenSectors, "forbiddenSectors");
  const forbiddenSet = new Set(forbidden);
  const conflict = required.find((sector) => forbiddenSet.has(sector));

  if (conflict) {
    throw new Error(`sector cannot be both required and forbidden: ${conflict}`);
  }

  const template = await readFile(TEMPLATE_URL, "utf8");
  const startIndex = template.indexOf(START_MARKER);
  const endIndex = template.indexOf(END_MARKER);

  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) {
    throw new Error("test_problem.pddl is missing valid generated-goal markers");
  }

  const goals = buildVisitGoals(required, forbidden);
  const replacement = goals
    ? `${START_MARKER}\n${goals}\n`
    : `${START_MARKER}\n`;

  return `${template.slice(0, startIndex)}${replacement}${template.slice(endIndex)}`;
}
