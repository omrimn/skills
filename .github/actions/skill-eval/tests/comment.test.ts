import { describe, it, expect } from 'vitest';
import {
  formatValidationErrors, COMMENT_MARKER,
  formatServiceError,
} from '../src/utils/comment';

describe('formatValidationErrors', () => {
  it('includes the comment marker', () => {
    const result = formatValidationErrors([{ entryTitle: 'T', message: 'msg' }]);
    expect(result).toContain(COMMENT_MARKER);
  });

  it('formats a single error', () => {
    const result = formatValidationErrors([{ entryTitle: 'Query Products', message: 'missing tags' }]);
    expect(result).toContain('**Query Products**: missing tags');
  });

  it('formats multiple errors as separate lines', () => {
    const result = formatValidationErrors([
      { entryTitle: 'Entry A', message: 'missing tags' },
      { entryTitle: 'Entry B', message: 'file not found: skills/x.md' },
    ]);
    expect(result).toContain('**Entry A**: missing tags');
    expect(result).toContain('**Entry B**: file not found: skills/x.md');
  });
});

describe('formatServiceError', () => {
  it('uses ⚠️ heading when non-blocking', () => {
    const body = formatServiceError('timeout', false);
    expect(body).toContain(COMMENT_MARKER);
    expect(body).toContain('⚠️');
    expect(body).toContain('Skill Evaluation: Warning');
    expect(body).not.toContain('❌');
  });

  it('uses ❌ heading when blocking', () => {
    const body = formatServiceError('timeout', true);
    expect(body).toContain('❌');
    expect(body).toContain('Skill Evaluation: Error');
    expect(body).not.toContain('⚠️');
  });
});
