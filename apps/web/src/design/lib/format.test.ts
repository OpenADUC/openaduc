// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import { capitalize } from './format.js';

describe('capitalize', () => {
  it('upper-cases the first letter and leaves the rest', () => {
    expect(capitalize('expires at 5 PM')).toBe('Expires at 5 PM');
    expect(capitalize('user')).toBe('User');
    expect(capitalize('')).toBe('');
  });
});
