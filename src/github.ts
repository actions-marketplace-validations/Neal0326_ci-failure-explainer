import * as core from "@actions/core";
import * as github from "@actions/github";

const FAILURE_CONCLUSIONS = new Set([
  "action_required",
  "failure",
  "startup_failure",
  "timed_out",
]);

type WorkflowJobStep = {
  name?: string | null;
  number?: number | null;
  conclusion?: string | null;
};

type WorkflowJob = {
  id: number;
  name: string;
  html_url?: string | null;
  conclusion?: string | null;
  status?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  steps?: WorkflowJobStep[] | null;
};

export interface WorkflowContext {
  owner: string;
  repo: string;
  runId: number;
  runAttempt: number;
  workflow: string;
  eventName: string;
  sha: string;
  ref: string;
  serverUrl: string;
  apiUrl: string;
  runUrl: string;
  pullRequestNumber?: number;
  isPullRequest: boolean;
  isForkPullRequest: boolean;
  pullRequestHeadRepoFullName?: string;
  pullRequestBaseRepoFullName?: string;
}

export interface FailedJob {
  id: number;
  name: string;
  htmlUrl?: string;
  conclusion: string;
  status?: string;
  startedAt?: string;
  completedAt?: string;
  failingSteps: string[];
}

export function getWorkflowContext(): WorkflowContext {
  const { owner, repo } = github.context.repo;
  const runId = github.context.runId;
  const runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT ?? "1");
  const serverUrl = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const pullRequest = github.context.payload.pull_request;
  const pullRequestNumber =
    typeof pullRequest?.number === "number"
      ? pullRequest.number
      : undefined;
  const headRepoFullName =
    typeof pullRequest?.head?.repo?.full_name === "string"
      ? pullRequest.head.repo.full_name
      : undefined;
  const baseRepoFullName =
    typeof pullRequest?.base?.repo?.full_name === "string"
      ? pullRequest.base.repo.full_name
      : undefined;
  const isPullRequest = pullRequestNumber != null;
  const isForkPullRequest =
    isPullRequest &&
    headRepoFullName != null &&
    baseRepoFullName != null &&
    headRepoFullName !== baseRepoFullName;

  return {
    owner,
    repo,
    runId,
    runAttempt,
    workflow: github.context.workflow,
    eventName: github.context.eventName,
    sha: github.context.sha,
    ref: github.context.ref,
    serverUrl,
    apiUrl,
    runUrl: `${serverUrl}/${owner}/${repo}/actions/runs/${runId}`,
    pullRequestNumber,
    isPullRequest,
    isForkPullRequest,
    pullRequestHeadRepoFullName: headRepoFullName,
    pullRequestBaseRepoFullName: baseRepoFullName,
  };
}

export async function listFailedJobs(
  githubToken: string,
  context: WorkflowContext,
): Promise<FailedJob[]> {
  const octokit = github.getOctokit(githubToken);
  const jobs: WorkflowJob[] = [];
  let page = 1;

  while (true) {
    const response = await octokit.rest.actions.listJobsForWorkflowRunAttempt({
      owner: context.owner,
      repo: context.repo,
      run_id: context.runId,
      attempt_number: context.runAttempt,
      per_page: 100,
      page,
    });

    jobs.push(...(response.data.jobs as WorkflowJob[]));

    if (response.data.jobs.length < 100) {
      break;
    }

    page += 1;
  }

  return jobs
    .filter((job) => FAILURE_CONCLUSIONS.has(job.conclusion ?? ""))
    .map((job) => ({
      id: job.id,
      name: job.name,
      htmlUrl: job.html_url ?? undefined,
      conclusion: job.conclusion ?? "failure",
      status: job.status ?? undefined,
      startedAt: job.started_at ?? undefined,
      completedAt: job.completed_at ?? undefined,
      failingSteps: (job.steps ?? [])
        .filter((step) => FAILURE_CONCLUSIONS.has(step.conclusion ?? ""))
        .map((step) => {
          const prefix = step.number != null ? `Step ${step.number}: ` : "";
          return `${prefix}${step.name ?? "Unnamed step"}`;
        }),
    }))
    .sort((left, right) => {
      const leftTime = Date.parse(left.completedAt ?? left.startedAt ?? "");
      const rightTime = Date.parse(right.completedAt ?? right.startedAt ?? "");
      return Number.isNaN(rightTime) || Number.isNaN(leftTime)
        ? 0
        : rightTime - leftTime;
    });
}

export async function downloadJobLog(
  githubToken: string,
  context: WorkflowContext,
  jobId: number,
): Promise<string> {
  const response = await fetch(
    `${context.apiUrl}/repos/${context.owner}/${context.repo}/actions/jobs/${jobId}/logs`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${githubToken}`,
        "User-Agent": "ci-failure-explainer",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    },
  );

  if (!response.ok) {
    throw new Error(
      `GitHub log download failed for job ${jobId}: ${response.status} ${response.statusText}`,
    );
  }

  return response.text();
}

export async function upsertPullRequestComment(
  githubToken: string,
  context: WorkflowContext,
  pullRequestNumber: number,
  body: string,
): Promise<void> {
  const octokit = github.getOctokit(githubToken);
  const marker = "<!-- ci-failure-explainer -->";
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner: context.owner,
    repo: context.repo,
    issue_number: pullRequestNumber,
    per_page: 100,
  });

  const existing = comments.find(
    (comment) =>
      comment.user?.type === "Bot" && comment.body?.includes(marker),
  );

  if (existing) {
    await octokit.rest.issues.updateComment({
      owner: context.owner,
      repo: context.repo,
      comment_id: existing.id,
      body,
    });
    return;
  }

  await octokit.rest.issues.createComment({
    owner: context.owner,
    repo: context.repo,
    issue_number: pullRequestNumber,
    body,
  });
}

export async function writeJobSummary(markdown: string): Promise<void> {
  await core.summary.addRaw(markdown, true).write({ overwrite: true });
}
