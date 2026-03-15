import * as core from "@actions/core";

import {
  downloadJobLog,
  getWorkflowContext,
  listFailedJobs,
  type FailedJob,
  upsertPullRequestComment,
  writeJobSummary,
} from "./github";
import {
  explainFailureWithOpenAI,
  type FailureExplanation,
  normalizeConfidenceLevel,
} from "./openai";

const DEFAULT_MODEL = "gpt-4.1-mini";
const MAX_TOTAL_LOG_BYTES = 120_000;
const MAX_PER_JOB_LOG_BYTES = 60_000;
const LOG_SECTION_SEPARATOR = "\n\n==========\n\n";

type AnalysisStatus = "success" | "fallback" | "skipped";

interface PreparedJob extends FailedJob {
  log: string;
  originalBytes: number;
  sanitizedBytes: number;
  truncated: boolean;
}

function stripAnsi(text: string): string {
  return text.replace(
    // eslint-disable-next-line no-control-regex
    /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g,
    "",
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function gatherSecrets(explicitSecrets: string[]): string[] {
  const values = new Set<string>();

  for (const secret of explicitSecrets) {
    if (secret && secret.length >= 8) {
      values.add(secret);
    }
  }

  for (const [key, value] of Object.entries(process.env)) {
    if (!value || value.length < 8) {
      continue;
    }

    if (/(TOKEN|KEY|SECRET|PASSWORD)/i.test(key)) {
      values.add(value);
    }
  }

  return [...values];
}

function redactSecrets(text: string, secrets: string[]): string {
  let result = text;

  for (const secret of secrets) {
    result = result.replace(new RegExp(escapeRegExp(secret), "g"), "[REDACTED]");
  }

  return result
    .replace(/\b(?:gh[oprsu]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bsk-[A-Za-z0-9]{16,}\b/g, "[REDACTED_OPENAI_KEY]")
    .replace(/Bearer\s+[A-Za-z0-9._-]{10,}/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:token|access_token|client_secret|signature)=)[^&\s]+/gi, "$1[REDACTED]");
}

function sliceUtf8Start(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }

  let low = 0;
  let high = text.length;

  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = text.slice(0, mid);
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return text.slice(0, low);
}

function sliceUtf8End(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }

  let low = 0;
  let high = text.length;

  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = text.slice(text.length - mid);
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return text.slice(text.length - low);
}

function sanitizeAndTruncateLog(
  rawLog: string,
  secrets: string[],
  maxBytes: number,
): Pick<PreparedJob, "log" | "originalBytes" | "sanitizedBytes" | "truncated"> {
  const originalBytes = Buffer.byteLength(rawLog, "utf8");
  let sanitized = stripAnsi(rawLog)
    .replace(/\r\n/g, "\n")
    .replace(/\0/g, "")
    .replace(/[^\S\n]+\n/g, "\n")
    .trim();

  sanitized = redactSecrets(sanitized, secrets);
  const sanitizedBytes = Buffer.byteLength(sanitized, "utf8");

  if (sanitizedBytes <= maxBytes) {
    return {
      log: sanitized,
      originalBytes,
      sanitizedBytes,
      truncated: false,
    };
  }

  const marker = "\n\n[... log truncated to fit prompt budget ...]\n\n";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const headBudget = Math.min(18_000, Math.floor(maxBytes * 0.2));
  const tailBudget = Math.max(maxBytes - headBudget - markerBytes, 0);

  const truncated =
    `${sliceUtf8Start(sanitized, headBudget)}${marker}${sliceUtf8End(
      sanitized,
      tailBudget,
    )}`.trim();

  return {
    log: truncated,
    originalBytes,
    sanitizedBytes,
    truncated: true,
  };
}

function prepareJobs(
  jobs: Array<FailedJob & { rawLog: string }>,
  secrets: string[],
): PreparedJob[] {
  const perJobBudget = Math.max(
    16_000,
    Math.min(MAX_PER_JOB_LOG_BYTES, Math.floor(MAX_TOTAL_LOG_BYTES / Math.max(jobs.length, 1))),
  );

  return jobs.map((job) => {
    const processed = sanitizeAndTruncateLog(job.rawLog, secrets, perJobBudget);
    return {
      ...job,
      ...processed,
    };
  });
}

function renderPrompt(preparedJobs: PreparedJob[], runUrl: string, workflow: string): string {
  const jobBlocks = preparedJobs.map((job) => {
    const failingSteps =
      job.failingSteps.length > 0 ? job.failingSteps.join(", ") : "No failing step metadata available";
    const logNotes = [
      `original_bytes=${job.originalBytes}`,
      `sanitized_bytes=${job.sanitizedBytes}`,
      `truncated=${job.truncated ? "yes" : "no"}`,
    ].join(", ");

    return [
      `Job: ${job.name}`,
      `Conclusion: ${job.conclusion}`,
      `Status: ${job.status ?? "unknown"}`,
      `Started At: ${job.startedAt ?? "unknown"}`,
      `Completed At: ${job.completedAt ?? "unknown"}`,
      `Failing Steps: ${failingSteps}`,
      `Log Metadata: ${logNotes}`,
      "Logs:",
      job.log,
    ].join("\n");
  });

  const prompt = [
    "Analyze this GitHub Actions failure.",
    `Workflow: ${workflow}`,
    `Run URL: ${runUrl}`,
    `Failed Jobs: ${preparedJobs.map((job) => job.name).join(", ")}`,
    "",
    "Return JSON only.",
    "",
    jobBlocks.join(LOG_SECTION_SEPARATOR),
  ].join("\n");

  return sliceUtf8Start(prompt, MAX_TOTAL_LOG_BYTES + 10_000);
}

function renderMarkdown(
  status: AnalysisStatus,
  explanation: FailureExplanation | undefined,
  jobs: PreparedJob[],
  runUrl: string,
  workflow: string,
  model: string,
  note?: string,
): string {
  const jobLines = jobs
    .map((job) => {
      const detail = job.failingSteps.length > 0 ? ` (${job.failingSteps.join("; ")})` : "";
      return `- \`${job.name}\`${detail}`;
    })
    .join("\n");

  const fixSteps = explanation
    ? explanation.specificFixSteps.map((step, index) => `${index + 1}. ${step}`).join("\n")
    : "1. Inspect the failed jobs linked above.\n2. Review the final log lines for the failing step.\n3. Re-run with extra debug output if the failure is still unclear.";

  const statusDescriptions: Record<AnalysisStatus, string> = {
    success: "OpenAI analysis completed successfully.",
    fallback: "OpenAI analysis failed, so this report uses a deterministic fallback summary.",
    skipped: "AI analysis was skipped.",
  };
  const renderedNote = note ? `${note}\n\n` : "";

  return `<!-- ci-failure-explainer -->
## CI Failure Explainer

**Workflow:** ${workflow}  
**Run:** [View workflow run](${runUrl})  
**Model:** \`${model}\`  
**Analysis Status:** \`${status}\`

${statusDescriptions[status]}

${renderedNote}### Failed Jobs
${jobLines}

### Short Summary
${explanation?.shortSummary ?? "AI analysis was skipped before calling OpenAI."}

### Likely Root Cause
${explanation?.likelyRootCause ?? "No AI root cause was generated. Review the failed job list and linked workflow run for the first failing step."}

### Specific Fix Steps
${fixSteps}

### Confidence Level
\`${explanation?.confidenceLevel ?? "low"}\`

Logs may be truncated for analysis.
`;
}

function buildFallbackExplanation(jobs: PreparedJob[], reason: string): FailureExplanation {
  const primaryJob = jobs[0];
  const failingStepSummary =
    primaryJob?.failingSteps.length ? primaryJob.failingSteps.join(", ") : "the failing log tail";

  return {
    shortSummary: `OpenAI analysis was unavailable. ${jobs.length} failed job(s) were detected, with ${primaryJob?.name ?? "an unknown job"} as the most recent failure.`,
    likelyRootCause: `The strongest local signal points to ${primaryJob?.name ?? "the failed job"}, especially around ${failingStepSummary}. Review the linked run and the last failing command output before changing the workflow.`,
    specificFixSteps: [
      `Open the workflow run and inspect ${primaryJob?.name ?? "the failed job"} first.`,
      `Review the failing step output around ${failingStepSummary}.`,
      "Compare recent changes to workflow YAML, dependencies, environment variables, and test setup.",
      `If the issue is still unclear, re-run CI with additional debug logging. Fallback reason: ${reason}`,
    ],
    confidenceLevel: normalizeConfidenceLevel("low"),
  };
}

function renderRetrievalFailureMarkdown(message: string): string {
  return `## CI Failure Explainer

**Analysis Status:** \`skipped\`

The action could not retrieve workflow failure data from GitHub, so no AI analysis was attempted.

${message}
`;
}

function renderNoFailuresMarkdown(runUrl: string, workflow: string): string {
  return `## CI Failure Explainer

**Workflow:** ${workflow}  
**Run:** [View workflow run](${runUrl})  
**Analysis Status:** \`skipped\`

No completed failed jobs were found in the current workflow run attempt. Run this action from a dedicated follow-up job with \`if: failure()\` after the main CI jobs finish.
`;
}

function getSkipReason(
  openaiApiKey: string,
  eventName: string,
  isForkPullRequest: boolean,
): string | undefined {
  if (openaiApiKey.trim().length > 0) {
    return undefined;
  }

  if (isForkPullRequest && eventName === "pull_request") {
    return "This pull request originated from a fork and the OpenAI API key was not available. GitHub does not expose repository secrets to forked pull_request workflows, so AI analysis was skipped.";
  }

  return "The OpenAI API key input was empty, so AI analysis was skipped.";
}

async function finalizeOutputs(
  analysisStatus: AnalysisStatus,
  failedJobCount: number,
  pullRequestCommented: boolean,
): Promise<void> {
  core.setOutput("analysis-status", analysisStatus);
  core.setOutput("failed-job-count", String(failedJobCount));
  core.setOutput("pull-request-commented", String(pullRequestCommented));
}

async function run(): Promise<void> {
  let analysisStatus: AnalysisStatus = "skipped";
  let failedJobCount = 0;
  let pullRequestCommented = false;

  try {
    const githubToken = core.getInput("github-token", { required: true });
    const openaiApiKey = core.getInput("openai-api-key").trim();
    const model = core.getInput("model") || DEFAULT_MODEL;
    const workflowContext = getWorkflowContext();

    core.info(
      `Inspecting workflow run ${workflowContext.runId} attempt ${workflowContext.runAttempt} in ${workflowContext.owner}/${workflowContext.repo}.`,
    );

    let failedJobs: FailedJob[];
    try {
      failedJobs = await listFailedJobs(githubToken, workflowContext);
    } catch (error) {
      const message = `Failed to retrieve workflow jobs from GitHub. ${
        error instanceof Error ? error.message : String(error)
      }`;
      await writeJobSummary(renderRetrievalFailureMarkdown(message));
      await finalizeOutputs(analysisStatus, failedJobCount, pullRequestCommented);
      core.setFailed(message);
      return;
    }

    failedJobCount = failedJobs.length;

    if (failedJobs.length === 0) {
      await writeJobSummary(
        renderNoFailuresMarkdown(workflowContext.runUrl, workflowContext.workflow),
      );
      await finalizeOutputs(analysisStatus, failedJobCount, pullRequestCommented);
      return;
    }

    core.info(`Found ${failedJobs.length} failed job(s). Downloading logs.`);

    let jobsWithLogs: Array<FailedJob & { rawLog: string }>;
    try {
      jobsWithLogs = await Promise.all(
        failedJobs.map(async (job) => {
          const rawLog = await downloadJobLog(githubToken, workflowContext, job.id);
          return {
            ...job,
            rawLog,
          };
        }),
      );
    } catch (error) {
      const message = `Failed to download workflow job logs from GitHub. ${
        error instanceof Error ? error.message : String(error)
      }`;
      await writeJobSummary(renderRetrievalFailureMarkdown(message));
      await finalizeOutputs(analysisStatus, failedJobCount, pullRequestCommented);
      core.setFailed(message);
      return;
    }

    const secrets = gatherSecrets([githubToken, openaiApiKey]);
    const preparedJobs = prepareJobs(jobsWithLogs, secrets);
    const skipReason = getSkipReason(
      openaiApiKey,
      workflowContext.eventName,
      workflowContext.isForkPullRequest,
    );
    const shouldSkipPullRequestComment =
      workflowContext.isForkPullRequest && workflowContext.eventName === "pull_request";
    let explanation: FailureExplanation | undefined;
    let note: string | undefined;

    if (skipReason) {
      analysisStatus = "skipped";
      note = skipReason;
      core.info(skipReason);
    } else {
      const prompt = renderPrompt(
        preparedJobs,
        workflowContext.runUrl,
        workflowContext.workflow,
      );

      try {
        core.info(`Sending ${preparedJobs.length} failed job log(s) to OpenAI model ${model}.`);
        explanation = await explainFailureWithOpenAI({
          apiKey: openaiApiKey,
          model,
          prompt,
        });
        analysisStatus = "success";
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        explanation = buildFallbackExplanation(preparedJobs, reason);
        analysisStatus = "fallback";
        note = `OpenAI analysis failed and a fallback explanation was generated instead. ${reason}`;
        core.warning(note);
      }
    }

    const markdown = renderMarkdown(
      analysisStatus,
      explanation,
      preparedJobs,
      workflowContext.runUrl,
      workflowContext.workflow,
      model,
      note,
    );

    await writeJobSummary(markdown);

    if (workflowContext.pullRequestNumber != null && !shouldSkipPullRequestComment) {
      try {
        await upsertPullRequestComment(
          githubToken,
          workflowContext,
          workflowContext.pullRequestNumber,
          markdown,
        );
        pullRequestCommented = true;
        core.info(`Posted explanation to PR #${workflowContext.pullRequestNumber}.`);
      } catch (error) {
        core.warning(
          `Failed to post PR comment. The explanation is still available in the job summary. ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    } else if (workflowContext.pullRequestNumber != null) {
      core.info("Fork pull request detected. Skipping PR comment and leaving the result in the job summary.");
    } else {
      core.info("No pull request context detected. Wrote explanation to the job summary.");
    }

    await finalizeOutputs(analysisStatus, failedJobCount, pullRequestCommented);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await writeJobSummary(renderRetrievalFailureMarkdown(message));
    } catch {
      // Ignore summary write failures here; the action still needs to report the main error.
    }
    await finalizeOutputs(analysisStatus, failedJobCount, pullRequestCommented);
    core.setFailed(message);
  }
}

void run();
