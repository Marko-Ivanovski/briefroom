import { describe, expect, it } from 'vitest';
import { createdStamp, updatedStamp } from '../src/audit.ts';

describe('audit stamps', () => {
  it('createdStamp fills created and updated columns from one actor', () => {
    const s = createdStamp({ userId: 'u1', via: 'mcp', agent: 'claude-code' });
    expect(s.createdBy).toBe('u1');
    expect(s.updatedBy).toBe('u1');
    expect(s.createdVia).toBe('mcp');
    expect(s.createdAgent).toBe('claude-code');
  });

  it('updatedStamp leaves created columns out', () => {
    expect(Object.keys(updatedStamp({ userId: 'u2', via: 'web' })).sort()).toEqual([
      'updatedAgent',
      'updatedAt',
      'updatedBy',
      'updatedVia',
    ]);
  });
});
