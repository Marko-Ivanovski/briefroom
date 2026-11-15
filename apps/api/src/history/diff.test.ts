import { describe, expect, it } from 'vitest';
import { diffRecord } from './diff.ts';

const x = new Date('2026-01-01T00:00:00Z');
const y = new Date('2026-01-02T00:00:00Z');

describe('diffRecord', () => {
  it('reports only the fields that changed and leaves out audit columns', () => {
    expect(diffRecord({ text: 'a', updatedAt: x }, { text: 'b', updatedAt: y })).toEqual({
      text: { from: 'a', to: 'b' },
    });
  });

  it('treats a null before as a creation and lists every field', () => {
    expect(
      diffRecord(null, {
        id: 'n1',
        workspaceId: 'w1',
        text: 'a',
        projectId: null,
        createdBy: 'u1',
        createdAt: x,
      }),
    ).toEqual({ text: { from: null, to: 'a' } });
  });

  it('omits id, workspace_id and snake_case audit columns', () => {
    expect(
      diffRecord(
        { id: 1, workspace_id: 'a', updated_by: 'u', text: 'a' },
        { id: 2, workspace_id: 'b', updated_by: 'v', text: 'a' },
      ),
    ).toEqual({});
  });

  it('compares dates and nested values by value', () => {
    expect(
      diffRecord(
        { at: new Date(x), tags: ['a', { b: 1 }] },
        { at: new Date(x), tags: ['a', { b: 1 }] },
      ),
    ).toEqual({});
    expect(diffRecord({ tags: ['a'] }, { tags: ['a', 'b'] })).toEqual({
      tags: { from: ['a'], to: ['a', 'b'] },
    });
  });

  it('records a field that only exists after as from null', () => {
    expect(diffRecord({ a: 1 }, { a: 1, b: 2 })).toEqual({ b: { from: null, to: 2 } });
  });
});
