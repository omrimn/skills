import * as core from '@actions/core';
import { getEvalConfig } from './config';
import * as github from '@actions/github';
import { getChangedFiles, upsertComment, fail } from './github';
import { EvalForgeClient } from './evalforge';
import { categorizeChanges } from './paths';
import { collectSkillChanges } from './skill-changes';
import {
  formatValidationErrors, formatFailedJobMessage, formatValidationPassed,
  formatServiceError,
} from './comment';
import type { ValidationError } from './yaml';

export async function runEval(): Promise<void> {
  const config = getEvalConfig();
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

  core.info(`Affected entries: ${entries.map(e => e.title).join(', ')}`);

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
    for (const tag of entry.tags ?? []) {
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

  const tags = [...new Set(entries.flatMap(e => e.tags ?? []))];
  await upsertComment(octokit, config, formatValidationPassed(tags));
  core.info(`Validation passed — ${tags.length} tag(s) verified: ${tags.join(', ')}`);
}
