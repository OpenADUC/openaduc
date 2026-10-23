// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client.js';
import { errorMessage } from './errorMessage.js';

describe('errorMessage', () => {
  it('passes on what the API said', () => {
    expect(errorMessage(new ApiError(409, 'conflict', 'jsmith is already taken'), 'Failed')).toBe(
      'jsmith is already taken',
    );
  });

  it('passes on the message of any other error, such as a dropped connection', () => {
    expect(errorMessage(new TypeError('Failed to fetch'), 'Failed')).toBe('Failed to fetch');
  });

  it('falls back when there is no message to show', () => {
    expect(errorMessage('boom', 'Failed to load OUs')).toBe('Failed to load OUs');
    expect(errorMessage(new Error(''), 'Failed to load OUs')).toBe('Failed to load OUs');
  });
});
