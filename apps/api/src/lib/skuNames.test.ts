// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it, vi } from 'vitest';
import { readSkuNames, skuName } from './skuNames.js';

describe('skuName', () => {
  it('names a product as Microsoft’s list does', () => {
    expect(skuName('05e9a617-0261-4cee-bb44-138d3ef5d965', 'SPE_E3')).toBe('Microsoft 365 E3');
    expect(skuName('05E9A617-0261-4CEE-BB44-138D3EF5D965', null)).toBe('Microsoft 365 E3');
  });

  it('falls back to the part number for a product the list lacks', () => {
    expect(skuName('00000000-0000-0000-0000-000000000001', 'CONTOSO_PLAN')).toBe('CONTOSO_PLAN');
  });

  it('falls back to the id when the part number isn’t known either', () => {
    expect(skuName('00000000-0000-0000-0000-000000000001', null)).toBe(
      '00000000-0000-0000-0000-000000000001',
    );
  });

  it('warns, and names nothing, when the list can’t be read', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(readSkuNames(new URL('file:///nonexistent/sku-names.csv')).size).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('license product names unavailable'));
    warn.mockRestore();
  });
});
