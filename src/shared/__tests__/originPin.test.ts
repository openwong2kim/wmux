import { describe, expect, it } from 'vitest';
import { isOriginPin, normalizeOriginPin, originPinMatches } from '../originPin';
import { originUrlRepoKey } from '../../main/worktask/workerGit';

describe('normalizeOriginPin', () => {
  it('writes the default port out, lowercases the host and keeps the path case, the ssh user and the form', () => {
    expect(normalizeOriginPin(' https://GitLab.Corp.Example/Team/App.git/ ')).toBe('https://gitlab.corp.example:443/Team/App');
    expect(normalizeOriginPin('HTTPS://gitlab.corp.example:443/Team/App')).toBe('https://gitlab.corp.example:443/Team/App');
    expect(normalizeOriginPin('https://deploy@gitlab.corp.example:8443/g/sub/p.git')).toBe('https://gitlab.corp.example:8443/g/sub/p');
    expect(normalizeOriginPin('ssh://git@GitLab.Corp.Example/Team/App.git')).toBe('ssh://git@gitlab.corp.example:22/Team/App');
    expect(normalizeOriginPin('ssh://Deploy@host.example:2222/Team/App')).toBe('ssh://Deploy@host.example:2222/Team/App');
    expect(normalizeOriginPin('ssh://host.example/Team/App')).toBe('ssh://host.example:22/Team/App');
    expect(normalizeOriginPin('git@GitHub.com:Acme/App.git')).toBe('git@github.com:Acme/App');
  });

  it('a pin normalizes to itself', () => {
    for (const u of ['https://h.example/a/b', 'ssh://git@h.example:2222/a/b.git', 'git@h.example:a/b', 'git@github-work:org/repo']) {
      const pin = normalizeOriginPin(u);
      expect(pin, u).not.toBeNull();
      expect(isOriginPin(pin), u).toBe(true);
      expect(normalizeOriginPin(pin)).toBe(pin);
    }
    expect(isOriginPin('https://h.example/a/b')).toBe(false);
  });

  it('accepts exactly the addresses a repo key is read from', () => {
    for (const bad of ['/srv/app.git', 'file:///srv/app.git', 'ext::sh -c x', 'http://h.example/a/b', 'https://h.example/a/b?x=1', 'https://u:secret@h.example/a/b',
      'git@h.example:22:a/b', 'https://h.example/a/../b', 'https://h.example:99999/a/b', 'ssh://-oProxyCommand=x@h.example/a/b', '-oProxyCommand@h.example:a/b', 'github-work:org/repo', 'https://h.example/repo']) {
      expect(normalizeOriginPin(bad), bad).toBeNull();
    }
    for (const u of ['https://h.example/a/b', 'ssh://git@h.example:2222/a/b', 'git@h.example:a/b']) {
      expect(normalizeOriginPin(u) !== null, u).toBe(originUrlRepoKey(u) !== null);
    }
  });
});

describe('originPinMatches', () => {
  const pin = (u: string) => normalizeOriginPin(u) as string;

  it('a self-hosted repository spelled App or app is one repository (the path case is ignored on every host)', () => {
    expect(originPinMatches(pin('https://git.corp.example/team/App.git'), 'https://git.corp.example/team/app.git')).toBe(true);
    expect(originPinMatches(pin('git@git.corp.example:team/App.git'), 'git@git.corp.example:Team/app')).toBe(true);
  });

  it('compares the port: 22 and 2222 are different servers', () => {
    expect(originPinMatches(pin('ssh://git@git.corp.example:22/team/app.git'), 'ssh://git@git.corp.example:2222/team/app.git')).toBe(false);
    expect(originPinMatches(pin('ssh://git@git.corp.example/team/app.git'), 'ssh://git@git.corp.example:2222/team/app.git')).toBe(false);
    expect(originPinMatches(pin('https://git.corp.example/team/app'), 'https://git.corp.example:8443/team/app')).toBe(false);
    // The default port written or not is the same address.
    expect(originPinMatches(pin('ssh://git@git.corp.example/team/app.git'), 'ssh://git@git.corp.example:22/team/app')).toBe(true);
    expect(originPinMatches(pin('https://git.corp.example/team/app'), 'https://git.corp.example:443/team/app.git')).toBe(true);
  });

  it('compares the host exactly', () => {
    expect(originPinMatches(pin('https://github.com/acme/app'), 'https://gitlab.com/acme/app')).toBe(false);
    expect(originPinMatches(pin('git@github.com:acme/app'), 'git@github.com.evil.example:acme/app')).toBe(false);
    expect(originPinMatches(pin('https://github.com/acme/app'), 'https://GitHub.com/acme/app')).toBe(true);
  });

  it('the transport-switch rule: https and ssh on the same host and path, both on default ports', () => {
    expect(originPinMatches(pin('https://github.com/acme/app.git'), 'git@github.com:acme/app.git')).toBe(true);
    expect(originPinMatches(pin('git@github.com:acme/app.git'), 'https://github.com/acme/app')).toBe(true);
    expect(originPinMatches(pin('https://github.com/acme/app'), 'ssh://git@github.com/acme/app')).toBe(true);
    // A non-default port on either side is not the same server.
    expect(originPinMatches(pin('https://git.corp.example:8443/team/app'), 'git@git.corp.example:team/app')).toBe(false);
    expect(originPinMatches(pin('https://git.corp.example/team/app'), 'ssh://git@git.corp.example:2222/team/app')).toBe(false);
    expect(originPinMatches(pin('https://github.com/acme/app'), 'git@github.com:acme/other')).toBe(false);
  });

  it('between ssh addresses, the user and the form are kept as recorded', () => {
    expect(originPinMatches(pin('git@git.corp.example:team/app'), 'deploy@git.corp.example:team/app')).toBe(false);
    expect(originPinMatches(pin('ssh://git@git.corp.example/team/app'), 'ssh://git.corp.example/team/app')).toBe(false);
    // scp-style is relative to the server's home, ssh:// is absolute.
    expect(originPinMatches(pin('git@git.corp.example:team/app'), 'ssh://git@git.corp.example/team/app')).toBe(false);
  });

  it('an ssh Host alias is a host name like any other: matched as written, never resolved', () => {
    expect(originPinMatches(pin('git@github-work:org/repo.git'), 'git@github-work:org/repo')).toBe(true);
    expect(originPinMatches(pin('git@github-work:org/repo'), 'git@github.com:org/repo')).toBe(false);
    expect(originPinMatches(pin('git@github.com:org/repo'), 'git@github-work:org/repo')).toBe(false);
    expect(originUrlRepoKey('git@github-work:org/repo')).toBe('github-work/org/repo');
  });

  it('never matches an address that is not plain', () => {
    expect(originPinMatches(pin('https://github.com/acme/app'), 'file:///github.com/acme/app')).toBe(false);
    expect(originPinMatches('not a pin', 'https://github.com/acme/app')).toBe(false);
  });
});
