// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import { computerWriteBlock } from './computerWrites.js';

describe('computerWriteBlock', () => {
  it('lets an ordinary workstation through, enabled or not', () => {
    expect(computerWriteBlock({ userAccountControl: '4096' })).toBeNull();
    expect(computerWriteBlock({ userAccountControl: '4098' })).toBeNull();
  });

  it('refuses a domain controller', () => {
    expect(computerWriteBlock({ userAccountControl: '532480' })).toBe('domain_controller');
  });

  it('refuses a read-only domain controller', () => {
    expect(computerWriteBlock({ userAccountControl: String(0x04001000) })).toBe(
      'read_only_domain_controller',
    );
  });

  it('refuses an object AD marks critical', () => {
    expect(computerWriteBlock({ userAccountControl: '4096', isCriticalSystemObject: 'TRUE' })).toBe(
      'critical_system_object',
    );
  });
});
