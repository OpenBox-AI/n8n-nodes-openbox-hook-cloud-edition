import { describe, expect, it } from 'vitest';

import {
  GovernanceBlockedError,
  GovernanceHaltError,
  GuardrailsValidationError,
  formatActivityRejectedMessage,
} from '../shared/langchain/verdict';

describe('formatActivityRejectedMessage', () => {
  it('includes the reason when Core provides one', () => {
    expect(formatActivityRejectedMessage('too risky')).toBe('Activity rejected: too risky');
  });

  it('does not repeat "Activity rejected" when no reason is given', () => {
    expect(formatActivityRejectedMessage(undefined)).toBe('Activity rejected (no reason provided)');
    expect(formatActivityRejectedMessage(null)).toBe('Activity rejected (no reason provided)');
    expect(formatActivityRejectedMessage('')).toBe('Activity rejected (no reason provided)');
    expect(formatActivityRejectedMessage('   ')).toBe('Activity rejected (no reason provided)');
  });
});
