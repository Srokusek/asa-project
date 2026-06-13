import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_PDDL_SOLVER_ENDPOINT =
  "http://localhost:5001/package/lama-first/solve";
export const DEFAULT_PDDL_SOLVER_TIMEOUT_MS = 30_000;
export const DEFAULT_PDDL_SOLVER_LOG_FILE = "logs/pddl-planner-results.jsonl";

const DEFAULT_POLL_INTERVAL_MS = 500;

function requirePositiveNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return number;
}

function requirePddl(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty PDDL string`);
  }
  return value;
}

function describeApiError(payload) {
  const error = payload?.Error ?? payload?.error;
  if (error == null) return null;
  return typeof error === "string" ? error : JSON.stringify(error);
}

async function fetchJson(fetchImpl, url, options, deadline) {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw new Error("PDDL solver request timed out");
  }

  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("PDDL solver request timed out"));
    }, remainingMs);
  });

  try {
    let response;
    try {
      response = await Promise.race([
        fetchImpl(url, {
          ...options,
          signal: controller.signal
        }),
        timeout
      ]);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error("PDDL solver request timed out", { cause: error });
      }
      throw new Error(`PDDL solver request failed: ${error.message}`, { cause: error });
    }

    if (!response || typeof response.ok !== "boolean") {
      throw new Error("PDDL solver returned an invalid HTTP response");
    }
    if (!response.ok) {
      throw new Error(`PDDL solver HTTP error: ${response.status} ${response.statusText}`.trim());
    }

    try {
      return await Promise.race([response.json(), timeout]);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error("PDDL solver request timed out", { cause: error });
      }
      throw new Error("PDDL solver returned malformed JSON", { cause: error });
    }
  } finally {
    clearTimeout(timer);
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compactPlannerResult(result) {
  const rawPlan = result?.result?.output?.sas_plan;
  return {
    status: String(result.status).toLowerCase(),
    solutionPlan:
      typeof rawPlan === "string" && rawPlan.trim().length > 0 ? rawPlan : null
  };
}

async function writePlannerResultLog({ logFile, logger }, result) {
  if (!logFile) return;

  const resolvedLogFile = resolve(logFile);
  try {
    await mkdir(dirname(resolvedLogFile), { recursive: true });
    await appendFile(
      resolvedLogFile,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        ...result
      })}\n`,
      "utf8"
    );
  } catch (error) {
    logger?.warn?.("PDDL planner result log write failed", {
      error: error.message
    });
  }
}

export async function solvePddl({
  domain,
  problem,
  fetchImpl = globalThis.fetch,
  endpoint = DEFAULT_PDDL_SOLVER_ENDPOINT,
  timeoutMs = DEFAULT_PDDL_SOLVER_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  logFile = DEFAULT_PDDL_SOLVER_LOG_FILE,
  logger = null
}) {
  const normalizedDomain = requirePddl(domain, "domain");
  const normalizedProblem = requirePddl(problem, "problem");
  if (typeof fetchImpl !== "function") {
    throw new Error("fetchImpl must be a function");
  }

  const normalizedEndpoint = new URL(endpoint).toString();
  const normalizedTimeoutMs = requirePositiveNumber(timeoutMs, "timeoutMs");
  const normalizedPollIntervalMs = requirePositiveNumber(pollIntervalMs, "pollIntervalMs");
  const deadline = Date.now() + normalizedTimeoutMs;

  const submission = await fetchJson(
    fetchImpl,
    normalizedEndpoint,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        domain: normalizedDomain,
        problem: normalizedProblem
      })
    },
    deadline
  );

  const submissionError = describeApiError(submission);
  if (submissionError) {
    throw new Error(`PDDL solver API error: ${submissionError}`);
  }

  if (!submission || typeof submission.result !== "string" || submission.result.trim().length === 0) {
    throw new Error("PDDL solver submission did not return a result URL");
  }

  const resultUrl = new URL(submission.result, normalizedEndpoint).toString();

  while (Date.now() < deadline) {
    const result = await fetchJson(fetchImpl, resultUrl, { method: "POST" }, deadline);
    const apiError = describeApiError(result);
    if (apiError) {
      throw new Error(`PDDL solver API error: ${apiError}`);
    }

    const status = typeof result?.status === "string" ? result.status.toUpperCase() : null;
    if (status === "OK") {
      const compactResult = compactPlannerResult(result);
      await writePlannerResultLog({ logFile, logger }, compactResult);
      return compactResult;
    }
    if (status !== "PENDING") {
      throw new Error(`PDDL solver returned unexpected task status: ${result?.status ?? "missing"}`);
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await wait(Math.min(normalizedPollIntervalMs, remainingMs));
  }

  throw new Error("PDDL solver request timed out");
}

async function runTestProblem() {
  const domainUrl = new URL("./test_domain.pddl", import.meta.url);
  const problemUrl = new URL("./test_problem.pddl", import.meta.url);
  const [domain, problem] = await Promise.all([
    readFile(domainUrl, "utf8"),
    readFile(problemUrl, "utf8")
  ]);

  const result = await solvePddl({ domain, problem });
  console.log(JSON.stringify(result, null, 2));
}

const isDirectRun =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  runTestProblem().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
