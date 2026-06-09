import * as core from '@actions/core';
import { runEval } from './utils/eval';
import { runCleanup } from './utils/cleanup';
import { runScheduled } from './utils/scheduled';

const mode = core.getInput('mode') || 'eval';
if (mode === 'cleanup') {
  runCleanup().catch(err => core.setFailed(err instanceof Error ? err.message : String(err)));
} else if (mode === 'scheduled') {
  runScheduled().catch(err => core.setFailed(err instanceof Error ? err.message : String(err)));
} else if (mode === 'eval') {
  runEval().catch(err => core.setFailed(err instanceof Error ? err.message : String(err)));
} else {
  core.setFailed(`Unknown mode: "${mode}". Valid modes are "eval", "scheduled", and "cleanup".`);
}
