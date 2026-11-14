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

  it('decodes percent-encoding so spellings of one repo match', () => {
    expect(normalizeRemote('ssh://git@gith%75b.com/o/r')).toBe(
      normalizeRemote('https://github.com/o/r'),
    );
    expect(normalizeRemote('https://github.com/%6Darko/r')).toBe('github.com/marko/r');
  });

  it.each([
    ['https://github.com/o/a%2Fb'],
    ['https://github.com/o/%ZZ'],
    ['C:/a/b'],
    [String.raw`c:\a\b`],
  ])('refuses %s', (u) => expect(() => normalizeRemote(u)).toThrow(InvalidRemoteError));

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
    ['https://tok@github.com/o/r', 'https://github.com/o/r'],
    ['https://user@host/o/r', 'https://host/o/r'],
    ['https://user:p%40ss@github.com/o/r', 'https://github.com/o/r'],
    ['https://a@b@github.com/o/r', 'https://github.com/o/r'],
    ['ssh://git@github.com/o/r.git', 'ssh://git@github.com/o/r.git'],
    ['ssh://u:p@host/o/r', 'ssh://host/o/r'],
    ['git+ssh://git@host/o/r', 'git+ssh://git@host/o/r'],
    ['git@github.com:o/r.git', 'git@github.com:o/r.git'],
    ['https://github.com/o/r.git?token=x#y', 'https://github.com/o/r.git'],
    ['https://github.com/o/r?access_token=ghp_x', 'https://github.com/o/r'],
    ['ssh://git@host/o/r?x=1', 'ssh://git@host/o/r'],
    ['  https://github.com/o/r  ', 'https://github.com/o/r'],
  ])('turns %s into %s', (input, out) => expect(stripCredentials(input)).toBe(out));

  it.each([
    ['https://tok@github.com:o/r'],
    ['git@git@host:o/r'],
    ['user:tok@host:o/r'],
    ['user%3Atok@github.com:o/r'],
    ['http://@/o/r'],
  ])('refuses %s', (input) => expect(() => stripCredentials(input)).toThrow(InvalidRemoteError));
});
