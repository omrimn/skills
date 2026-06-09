import * as core from '@actions/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { glob } from 'glob';
import { getConfig } from './utils/config';
import type { PrConfig, ScheduledConfig } from './utils/config';
import * as github from '@actions/github';
import { getChangedFiles, upsertComment, fail, findOpenRegressionIssue, upsertRegressionIssue, closeRegressionIssue } from './utils/github';
import { EvalForgeClient } from './utils/evalforge';
import { categorizeChanges } from './utils/paths';
import { collectSkillChanges } from './utils/skill-changes';
import { parseDocumentationYaml, filterSkillEntries } from './utils/yaml';
import { pollUntilDone } from './utils/eval-run';
import {
  formatValidationErrors, formatFailedJobMessage, formatValidationPassed,
  formatServiceError,
  formatScheduledResult,
} from './utils/comment';
import type { ValidationError } from './utils/yaml';

async function runPr(config: PrConfig): Promise<void> {
  const octokit = github.getOctokit(config.githubToken);

  core.info(`Skill eval — PR #${config.prNumber}`);

  let allFiles;
  try {
    allFiles = await getChangedFiles(octokit, config);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    core.error(`Failed to fetch changed files: ${message}`);
    await upsertComment(octokit, config, formatServiceError('Could not retrieve PR file list'));
    core.setFailed('Could not retrieve PR file list');
    return;
  }
  const { yamlFiles, mdFiles } = categorizeChanges(allFiles);

  if (yamlFiles.length === 0 && mdFiles.length === 0) {
    core.info('No relevant changes — skipping');
    return;
  }

  core.info(`Changed YAML files: ${yamlFiles.map(f => f.filename).join(', ') || 'none'}`);
  core.info(`Changed MD files: ${mdFiles.map(f => f.filename).join(', ') || 'none'}`);

  const { entries, errors } = await collectSkillChanges(
    octokit, config.owner, config.repo, yamlFiles, mdFiles, config.baseSha, process.env.GITHUB_WORKSPACE ?? process.cwd(),
  );

  if (entries.length === 0 && errors.length === 0) {
    core.info('No affected skill entries — skipping validation');
    return;
  }

  core.info(`Affected entries: ${entries.length}`);

  if (errors.length > 0) {
    await upsertComment(octokit, config, formatValidationErrors(errors));
    core.setFailed(formatFailedJobMessage(errors));
    return;
  }

  const evalforge = new EvalForgeClient(config.evalforgeUrl, config.appId, config.appSecret);

  let availableTags: Set<string>;
  try {
    availableTags = await evalforge.getTags(config.projectId);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    core.error(`Failed to fetch EvalForge tags: ${message}`);
    await upsertComment(octokit, config, formatServiceError('Could not reach EvalForge — contact a repository maintainer if this persists', config.blocking));
    fail('EvalForge validation could not run', config.blocking);
    return;
  }

  const tagErrors: ValidationError[] = [];
  for (const entry of entries) {
    for (const tag of entry.tags!) {
      if (!availableTags.has(tag)) {
        tagErrors.push({ entryTitle: entry.title, message: `unknown tag "${tag}"` });
      }
    }
  }

  if (tagErrors.length > 0) {
    await upsertComment(octokit, config, formatValidationErrors(tagErrors));
    core.setFailed(formatFailedJobMessage(tagErrors));
    return;
  }

  const tags = [...new Set(entries.flatMap(e => e.tags!))];
  await upsertComment(octokit, config, formatValidationPassed(tags));
  core.info(`Validation passed — ${tags.length} tag(s) verified: ${tags.join(', ')}`);
}

async function runScheduled(config: ScheduledConfig): Promise<void> {
  const octokit = github.getOctokit(config.githubToken);
  const sha = config.headSha;

  core.info(`Scheduled skill eval — commit ${sha.slice(0, 7)}`);

  const workspaceRoot = process.env.GITHUB_WORKSPACE ?? process.cwd();

  // Find YAML files changed in the last 25 hours (covers daily runs with a small buffer)
  let recentlyChangedYamlFiles: string[];
  try {
    const gitOutput = execSync(
      'git log --since="25 hours ago" --name-only --diff-filter=AM --pretty=format:""',
      { cwd: workspaceRoot, encoding: 'utf-8' },
    );
    recentlyChangedYamlFiles = gitOutput
      .split('\n')
      .map(f => f.trim())
      .filter(f => f.match(/^yaml\/wix-manage\/.+\/documentation\.yaml$/));
  } catch (e) {
    core.warning(`git log failed, falling back to all YAML files: ${e instanceof Error ? e.message : String(e)}`);
    recentlyChangedYamlFiles = await glob('yaml/wix-manage/**/documentation.yaml', { cwd: workspaceRoot });
  }

  if (recentlyChangedYamlFiles.length === 0) {
    core.info('No skill YAML files changed in the last 25 hours — skipping scheduled eval');
    return;
  }

  core.info(`Recently changed YAML files: ${recentlyChangedYamlFiles.join(', ')}`);

  const allTags = new Set<string>();
  for (const yamlPath of recentlyChangedYamlFiles) {
    try {
      const raw = readFileSync(join(workspaceRoot, yamlPath), 'utf-8');
      const entries = filterSkillEntries(parseDocumentationYaml(raw));
      for (const entry of entries) {
        for (const tag of entry.tags ?? []) {
          allTags.add(tag);
        }
      }
    } catch (e) {
      core.warning(`Failed to parse ${yamlPath}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const tags = [...allTags];
  core.info(`Collected ${tags.length} unique tag(s) from ${recentlyChangedYamlFiles.length} recently changed YAML file(s)`);

  if (tags.length === 0) {
    core.warning('No skill tags found — skipping scheduled eval');
    return;
  }

  const evalforge = new EvalForgeClient(config.evalforgeUrl, config.appId, config.appSecret);

  const versionLabel = `scheduled-${sha.slice(0, 7)}`;
  let mcpVersionId: string;
  try {
    const mcpVersion = await evalforge.createMcpVersion(config.mcpId, config.projectId, versionLabel, sha);
    mcpVersionId = mcpVersion.id;
    core.info(`Created MCP version ${versionLabel} (${mcpVersionId})`);
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 409) {
      core.warning(`MCP version ${versionLabel} already exists — looking up existing version`);
      try {
        const versions = await evalforge.listMcpVersions(config.mcpId, config.projectId);
        const existing = versions.find(v => v.version === versionLabel);
        if (!existing) throw new Error(`Version ${versionLabel} not found after 409`);
        mcpVersionId = existing.id;
        core.info(`Reusing existing MCP version ${versionLabel} (${mcpVersionId})`);
      } catch (lookupErr) {
        const message = lookupErr instanceof Error ? lookupErr.message : String(lookupErr);
        core.error(`Failed to look up existing MCP version: ${message}`);
        const issueNumber = await findOpenRegressionIssue(octokit, config.owner, config.repo);
        await upsertRegressionIssue(octokit, config.owner, config.repo, issueNumber, 'Scheduled skill eval: infrastructure error', formatScheduledResult('error', sha, { message: 'Could not look up existing MCP version' }));
        core.setFailed('Could not look up existing MCP version');
        return;
      }
    } else {
      const message = e instanceof Error ? e.message : String(e);
      core.error(`Failed to create MCP version: ${message}`);
      const issueNumber = await findOpenRegressionIssue(octokit, config.owner, config.repo);
      await upsertRegressionIssue(octokit, config.owner, config.repo, issueNumber, 'Scheduled skill eval: infrastructure error', formatScheduledResult('error', sha, { message: 'Could not create MCP version' }));
      core.setFailed('Could not create MCP version');
      return;
    }
  }

  let runId: string;
  try {
    const evalRun = await evalforge.createEvalRun(config.projectId, {
      name: `Scheduled skill eval (${sha.slice(0, 7)})`,
      description: `Scheduled skill eval against commit ${sha}`,
      projectId: config.projectId,
      tags,
      agentId: config.agentId,
      capabilityVersions: { [config.mcpId]: mcpVersionId },
    });
    runId = evalRun.id;
    core.info(`Created eval run ${runId}`);
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 400) {
      const message = e instanceof Error ? e.message : String(e);
      core.error(`createEvalRun 400 — no matching scenarios. Full error: ${message}`);
      core.warning(`No scenarios matched tags: ${tags.join(', ')}`);
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    core.error(`Failed to create eval run: ${message}`);
    const issueNumber = await findOpenRegressionIssue(octokit, config.owner, config.repo);
    await upsertRegressionIssue(octokit, config.owner, config.repo, issueNumber, 'Scheduled skill eval: infrastructure error', formatScheduledResult('error', sha, { message: 'Could not create eval run' }));
    core.setFailed('Could not create eval run');
    return;
  }

  try {
    await evalforge.triggerEvalRun(config.projectId, runId);
    core.info(`Triggered eval run ${runId}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    core.error(`Failed to trigger eval run: ${message}`);
    const issueNumber = await findOpenRegressionIssue(octokit, config.owner, config.repo);
    await upsertRegressionIssue(octokit, config.owner, config.repo, issueNumber, 'Scheduled skill eval: infrastructure error', formatScheduledResult('error', sha, { message: 'Could not trigger eval run' }));
    core.setFailed('Could not trigger eval run');
    return;
  }

  core.info(`Polling eval run ${runId}...`);

  let finalStatus;
  try {
    finalStatus = await pollUntilDone(evalforge, config.projectId, runId);
  } catch (e) {
    if ((e as { timeout?: boolean }).timeout) {
      const body = formatScheduledResult('timeout', sha, { runId });
      const issueNumber = await findOpenRegressionIssue(octokit, config.owner, config.repo);
      await upsertRegressionIssue(octokit, config.owner, config.repo, issueNumber, 'Scheduled skill eval: timed out', body);
      core.setFailed(`Skill evaluation timed out (run ID: ${runId})`);
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    core.error(`Eval run polling failed: ${message}`);
    const issueNumber = await findOpenRegressionIssue(octokit, config.owner, config.repo);
    await upsertRegressionIssue(octokit, config.owner, config.repo, issueNumber, 'Scheduled skill eval: infrastructure error', formatScheduledResult('error', sha, { message: 'Eval run polling failed' }));
    core.setFailed('Eval run polling failed');
    return;
  }

  const { aggregateMetrics: m } = finalStatus;

  if (finalStatus.status === 'completed' && m.failed === 0 && m.errors === 0) {
    core.info(`Eval passed — ${m.passed}/${m.totalAssertions} assertions passed (pass rate: ${m.passRate}%, run ID: ${runId})`);
    const issueNumber = await findOpenRegressionIssue(octokit, config.owner, config.repo);
    if (issueNumber !== null) {
      await closeRegressionIssue(octokit, config.owner, config.repo, issueNumber, formatScheduledResult('passed', sha, { runId, metrics: m }));
      core.info(`Closed regression issue #${issueNumber}`);
    }
  } else {
    const isInfraFailure = finalStatus.status === 'failed' || finalStatus.status === 'cancelled';
    const body = isInfraFailure
      ? formatScheduledResult('error', sha, { message: `Eval run ended with status: ${finalStatus.status} (run ID: ${runId})` })
      : formatScheduledResult('failed', sha, { runId, metrics: m });
    const title = isInfraFailure ? 'Scheduled skill eval: infrastructure error' : 'Scheduled skill eval: regression detected';
    core.info(`Eval result — ${m.failed} failed, ${m.errors} errors, ${m.passed}/${m.totalAssertions} passed (pass rate: ${m.passRate}%, run ID: ${runId})`);
    const issueNumber = await findOpenRegressionIssue(octokit, config.owner, config.repo);
    await upsertRegressionIssue(octokit, config.owner, config.repo, issueNumber, title, body);
    core.setFailed(`Skill evaluation failed (pass rate: ${m.passRate}%)`);
  }
}

async function run(): Promise<void> {
  const config = getConfig();
  if (config.mode === 'scheduled') {
    await runScheduled(config);
  } else {
    await runPr(config);
  }
}

run().catch(err => core.setFailed(err instanceof Error ? err.message : String(err)));
