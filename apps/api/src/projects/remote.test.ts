import { describe, expect, it } from 'vitest';
import { InvalidRemoteError, normalizeRemote, stripCredentials } from './remote.ts';

describe('normalizeRemote', () => {
  it.each([
    ['git@github.com:Marko/Briefroom.git'],
    ['https://github.com/marko/briefroom'],
    ['ssh://git@github.com/marko/briefroom.git'],
    ['https://user:tok@github.com:443/Marko/briefroom.git/'],
    ['  HTTPS://GitHub.com/Marko/Briefroom.git  '],
  ])('normalizes %s', (u) => expect(normalizeRemote(u)).toBe('github.com/marko/briefroom'));

  it('keeps nested groups', () =>
    expect(normalizeRemote('git@gitlab.com:group/sub/repo.git')).toBe('gitlab.com/group/sub/repo'));

  it('drops a port', () => expect(normalizeRemote('ssh://git@host:2222/o/r.git')).toBe('host/o/r'));

  it('rejects a non-remote', () =>
    expect(() => normalizeRemote('not a url')).toThrow(InvalidRemoteError));

  it.each([
    [''],
    ['   '],
    ['https://github.com'],
    ['https://github.com/onlyowner'],
    ['ftp://h/o/r'],
  ])('rejects %j', (u) => expect(() => normalizeRemote(u)).toThrow(InvalidRemoteError));
});

describe('stripCredentials', () => {
  it.each([
    ['https://user:tok@github.com/o/r.git', 'https://github.com/o/r.git'],
    ['https://user@github.com/o/r', 'https://user@github.com/o/r'],
    ['ssh://git@github.com/o/r.git', 'ssh://git@github.com/o/r.git'],
    ['ssh://u:p@host/o/r', 'ssh://host/o/r'],
    ['git@github.com:o/r.git', 'git@github.com:o/r.git'],
    ['user:tok@github.com:o/r.git', 'github.com:o/r.git'],
    ['  https://github.com/o/r  ', 'https://github.com/o/r'],
  ])('turns %s into %s', (input, out) => expect(stripCredentials(input)).toBe(out));
});
