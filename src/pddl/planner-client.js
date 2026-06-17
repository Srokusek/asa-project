import { appendFile, mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_PDDL_SOLVER_ENDPOINT =
  "http://localhost:5001/package/dual-bfws-ffparser/solve";
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

function errorDetails(error) {
  if (!(error instanceof Error)) {
    return {
      name: "Error",
      message: String(error)
    };
  }

  return {
    name: error.name,
    message: error.message,
    ...(error.details ? { details: error.details } : {}),
    ...(error.cause
      ? {
          cause: {
            name: error.cause.name ?? "Error",
            message: error.cause.message ?? String(error.cause)
          }
        }
      : {})
  };
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
      let responseBody = null;
      try {
        responseBody = await Promise.race([response.json(), timeout]);
      } catch {
        // The status and status text still identify the failed request.
      }
      const error = new Error(
        `PDDL solver HTTP error: ${response.status} ${response.statusText}`.trim()
      );
      error.details = {
        status: response.status,
        statusText: response.statusText,
        responseBody
      };
      throw error;
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

function inspectPlannerOutput(result) {
  const output = result?.result?.output;
  const normalizedOutput =
    output && typeof output === "object" && !Array.isArray(output) ? output : {};
  const selectedPlanKey = ["sas_plan", "plan"].find((key) => {
    const value = normalizedOutput[key];
    return typeof value === "string" && value.trim().length > 0;
  }) ?? null;

  return {
    output: normalizedOutput,
    outputKeys: Object.keys(normalizedOutput),
    selectedPlanKey,
    solutionPlan: selectedPlanKey ? normalizedOutput[selectedPlanKey] : null
  };
}

function compactPlannerResult(result, inspectedOutput = inspectPlannerOutput(result)) {
  return {
    status: String(result.status).toLowerCase(),
    solutionPlan: inspectedOutput.solutionPlan
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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
  const startedAt = Date.now();
  const deadline = Date.now() + normalizedTimeoutMs;
  const logContext = {
    endpoint: normalizedEndpoint,
    resultUrl: null,
    pollCount: 0,
    domainSha256: sha256(normalizedDomain),
    problemSha256: sha256(normalizedProblem),
    submission: null,
    plannerResult: null
  };
  let phase = "submission";
  let submission;
  let resultUrl;
  let pollCount = 0;

  try {
    submission = await fetchJson(
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
    logContext.submission = submission;

    const submissionError = describeApiError(submission);
    if (submissionError) {
      throw new Error(`PDDL solver API error: ${submissionError}`);
    }

    if (!submission || typeof submission.result !== "string" || submission.result.trim().length === 0) {
      throw new Error("PDDL solver submission did not return a result URL");
    }

    resultUrl = new URL(submission.result, normalizedEndpoint).toString();
    logContext.resultUrl = resultUrl;
    phase = "polling";

    while (Date.now() < deadline) {
      const result = await fetchJson(fetchImpl, resultUrl, { method: "POST" }, deadline);
      pollCount += 1;
      logContext.pollCount = pollCount;
      logContext.plannerResult = result;
      const apiError = describeApiError(result);
      if (apiError) {
        throw new Error(`PDDL solver API error: ${apiError}`);
      }

      const status = typeof result?.status === "string" ? result.status.toUpperCase() : null;
      if (status === "OK") {
        const inspectedOutput = inspectPlannerOutput(result);
        const compactResult = compactPlannerResult(result, inspectedOutput);
        await writePlannerResultLog(
          { logFile, logger },
          {
            ...compactResult,
            ...logContext,
            elapsedMs: Date.now() - startedAt,
            solverCall: result?.result?.call ?? null,
            outputType: result?.result?.output_type ?? null,
            outputKeys: inspectedOutput.outputKeys,
            selectedPlanKey: inspectedOutput.selectedPlanKey,
            stdout: result?.result?.stdout ?? null,
            stderr: result?.result?.stderr ?? null
          }
        );
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
  } catch (error) {
    const inspectedOutput = inspectPlannerOutput(logContext.plannerResult);
    await writePlannerResultLog(
      { logFile, logger },
      {
        status: "error",
        solutionPlan: null,
        ...logContext,
        phase,
        elapsedMs: Date.now() - startedAt,
        solverCall: logContext.plannerResult?.result?.call ?? null,
        outputType: logContext.plannerResult?.result?.output_type ?? null,
        outputKeys: inspectedOutput.outputKeys,
        selectedPlanKey: inspectedOutput.selectedPlanKey,
        stdout: logContext.plannerResult?.result?.stdout ?? null,
        stderr: logContext.plannerResult?.result?.stderr ?? null,
        error: errorDetails(error)
      }
    );
    throw error;
  }
}

async function runTestProblem() {
  const domainUrl = new URL("./big_domain.pddl", import.meta.url);
  const problemUrl = new URL("./big_problem.pddl", import.meta.url);
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
