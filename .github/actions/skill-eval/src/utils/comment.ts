import type { ValidationError } from './yaml';
import type { EvalRunStatus } from './evalforge';

export const COMMENT_MARKER = '<!-- skill-eval-action -->';

export function formatValidationErrors(errors: ValidationError[]): string {
  const lines = errors.map(e => `- **${e.entryTitle}**: ${e.message}`).join('\n');
  return [COMMENT_MARKER, '## ❌ Skill Validation: Failed', '', lines].join('\n');
}

export function formatServiceError(message: string, blocking = true): string {
  const icon = blocking ? '❌' : '⚠️';
  const heading = blocking ? 'Skill Evaluation: Error' : 'Skill Evaluation: Warning';
  return `${COMMENT_MARKER}\n## ${icon} ${heading}\n\n${message}`;
}

export function formatFailedJobMessage(errors: ValidationError[]): string {
  const lines = errors.map(e => `  - ${e.entryTitle}: ${e.message}`).join('\n');
  return `Skill validation failed (${errors.length} error${errors.length === 1 ? '' : 's'}):\n${lines}`;
}


export function formatValidationPassed(tags: string[]): string {
  return [
    COMMENT_MARKER,
    '## ✅ Skill Validation: Passed',
    '',
    `${tags.length} tag${tags.length === 1 ? '' : 's'} validated: ${tags.map(t => `\`${t}\``).join(', ')}`,
    '',
    '_Full eval runs on the scheduled cron, not on PRs._',
  ].join('\n');
}

const SCHEDULED_ICONS = { passed: '✅', failed: '❌', timeout: '⏱', error: '⚠️' } as const;
const SCHEDULED_TITLES = {
  passed: 'Scheduled Skill Eval: Passed',
  failed: 'Scheduled Skill Eval: Failed',
  timeout: 'Scheduled Skill Eval: Timed Out',
  error: 'Scheduled Skill Eval: Error',
} as const;

type ScheduledStatus = keyof typeof SCHEDULED_ICONS;
type ScheduledResultOpts = { runId?: string; metrics?: EvalRunStatus['aggregateMetrics']; message?: string };

export function formatScheduledResult(status: ScheduledStatus, sha: string, opts: ScheduledResultOpts = {}): string {
  const lines = [`## ${SCHEDULED_ICONS[status]} ${SCHEDULED_TITLES[status]}`, ''];
  if (opts.message) lines.push(opts.message);
  if (opts.metrics) {
    if (status === 'failed') lines.push(`Failed: ${opts.metrics.failed} assertions, ${opts.metrics.errors} errors`);
    lines.push(`Pass rate: ${opts.metrics.passRate}%`);
    lines.push(`Assertions: ${opts.metrics.passed}/${opts.metrics.totalAssertions} passed`);
  }
  lines.push(`Commit: \`${sha.slice(0, 7)}\``);
  if (opts.runId) lines.push(`Run ID: ${opts.runId}`);
  return lines.join('\n');
}
