import * as core from '@actions/core';
import * as github from '@actions/github';
import type { PrConfig } from './config';
import type { ChangedFile } from './paths';
import { COMMENT_MARKER } from './comment';

type Octokit = ReturnType<typeof github.getOctokit>;

export function fail(message: string, blocking: boolean): void {
  if (blocking) core.setFailed(message);
  else core.warning(message);
}

export async function getChangedFiles(octokit: Octokit, config: PrConfig): Promise<ChangedFile[]> {
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner: config.owner,
    repo: config.repo,
    pull_number: config.prNumber,
    per_page: 100,
  });
  return files.map(f => ({
    filename: f.filename,
    status: f.status,
    previousFilename: f.previous_filename,
  }));
}

export async function upsertComment(octokit: Octokit, config: PrConfig, body: string): Promise<void> {
  try {
    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      owner: config.owner,
      repo: config.repo,
      issue_number: config.prNumber,
      per_page: 100,
    });
    const existing = comments.find(c => c.body?.includes(COMMENT_MARKER));
    if (existing) {
      await octokit.rest.issues.updateComment({
        owner: config.owner,
        repo: config.repo,
        comment_id: existing.id,
        body,
      });
    } else {
      await octokit.rest.issues.createComment({
        owner: config.owner,
        repo: config.repo,
        issue_number: config.prNumber,
        body,
      });
    }
  } catch (e) {
    core.error(`Failed to post PR comment: ${e instanceof Error ? e.message : String(e)}`);
    await core.summary.addRaw(body).write();
  }
}

export const REGRESSION_LABEL = 'skill-eval-regression';

export async function findOpenRegressionIssue(octokit: Octokit, owner: string, repo: string): Promise<number | null> {
  const { data } = await octokit.rest.issues.listForRepo({
    owner,
    repo,
    state: 'open',
    labels: REGRESSION_LABEL,
    per_page: 1,
  });
  return data.length > 0 ? data[0].number : null;
}

export async function upsertRegressionIssue(octokit: Octokit, owner: string, repo: string, issueNumber: number | null, title: string, body: string): Promise<number> {
  if (issueNumber === null) {
    const { data } = await octokit.rest.issues.create({ owner, repo, title, body, labels: [REGRESSION_LABEL] });
    return data.number;
  }
  await octokit.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body });
  return issueNumber;
}

export async function closeRegressionIssue(octokit: Octokit, owner: string, repo: string, issueNumber: number, resolvedBody: string): Promise<void> {
  await octokit.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body: resolvedBody });
  await octokit.rest.issues.update({ owner, repo, issue_number: issueNumber, state: 'closed' });
}
