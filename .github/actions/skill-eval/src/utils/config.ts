import * as core from '@actions/core';
import * as github from '@actions/github';

type BaseConfig = {
  githubToken: string;
  evalforgeUrl: string;
  projectId: string;
  agentId: string;
  mcpId: string;
  appId: string;
  appSecret: string;
  owner: string;
  repo: string;
  blocking: boolean;
};

export type PrConfig = BaseConfig & {
  mode: 'pr';
  prNumber: number;
  baseSha: string;
  headSha: string;
};

export type ScheduledConfig = BaseConfig & {
  mode: 'scheduled';
  headSha: string;
};

export type Config = PrConfig | ScheduledConfig;

function ensureHttps(url: string): string {
  if (url.startsWith('https://')) return url;
  const upgraded = 'https://' + url.replace(/^https?:\/\//, '');
  core.warning(`evalforge-url was not HTTPS — upgraded to: ${upgraded}`);
  return upgraded;
}

function safeGetSecret(name: string): string {
  const value = core.getInput(name, { required: true });
  core.setSecret(value);
  return value;
}

export function getConfig(): Config {
  const mode = core.getInput('mode', { required: true });

  const base: BaseConfig = {
    githubToken: safeGetSecret('github-token'),
    evalforgeUrl: ensureHttps(core.getInput('evalforge-url', { required: true })),
    projectId: core.getInput('evalforge-project-id', { required: true }),
    agentId: core.getInput('evalforge-agent-id', { required: true }),
    mcpId: core.getInput('evalforge-mcp-id', { required: true }),
    appId: safeGetSecret('evalforge-app-id'),
    appSecret: safeGetSecret('evalforge-app-secret'),
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    blocking: core.getInput('blocking') !== 'false',
  };

  if (mode === 'scheduled') {
    const headSha = github.context.sha;
    if (!headSha) throw new Error('No commit SHA in context — action must be triggered by a schedule or workflow_dispatch event');
    return { ...base, mode: 'scheduled', headSha };
  }

  const pr = github.context.payload.pull_request;
  if (!pr) throw new Error('No pull_request payload — action must be triggered by a pull_request event');
  const prNumber = pr.number as number | undefined;
  const baseSha = (pr.base as { sha?: string } | undefined)?.sha;
  const headSha = (pr.head as { sha?: string } | undefined)?.sha;
  if (!prNumber || !baseSha || !headSha) throw new Error('PR payload is missing required fields (number, base.sha, or head.sha)');

  return { ...base, mode: 'pr', prNumber, baseSha, headSha };
}
