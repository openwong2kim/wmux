import { describe, expect, it } from 'vitest';
import { isOriginPin, namesNonDefaultPort, normalizeOriginPin, originPinMatches, parseOriginAddress, sameOriginEndpoint } from '../originPin';
import { originUrlRepoKey } from '../../main/worktask/workerGit';

describe('origin addresses', () => {
  it('reads the scheme and host in any case, an https port as 443 when unwritten, an ssh port only as written; the path case, the ssh user and the form are kept', () => {
    expect(normalizeOriginPin('https://GitLab.Corp.Example/Team/App.git/')).toBe('https://gitlab.corp.example:443/Team/App');
    expect(normalizeOriginPin('HTTPS://gitlab.corp.example:443/Team/App')).toBe('https://gitlab.corp.example:443/Team/App');
    expect(normalizeOriginPin('https://deploy@gitlab.corp.example:8443/g/sub/p.git')).toBe('https://gitlab.corp.example:8443/g/sub/p');
    // With no port, ssh's own config picks one: none is kept as none.
    expect(normalizeOriginPin('ssh://git@GitLab.Corp.Example/Team/App.git')).toBe('ssh://git@gitlab.corp.example/Team/App');
    expect(normalizeOriginPin('ssh://git@GitLab.Corp.Example:22/Team/App.git')).toBe('ssh://git@gitlab.corp.example:22/Team/App');
    expect(normalizeOriginPin('ssh://Deploy@host.example:2222/Team/App')).toBe('ssh://Deploy@host.example:2222/Team/App');
    expect(normalizeOriginPin('git@GitHub.com:Acme/App.git')).toBe('git@github.com:Acme/App');
  });

  it('a pin is a plain address as written; anything else is not', () => {
    for (const u of ['https://h.example/a/b.git', 'ssh://git@h.example:2222/a/b.git', 'git@h.example:a/b', 'git@github-work:org/repo']) expect(isOriginPin(u), u).toBe(true);
    for (const bad of ['/srv/app.git', 'file:///srv/app.git', 'ext::sh -c x', 'http://h.example/a/b', 'https://h.example/a/b?x=1', 'https://u:secret@h.example/a/b',
      'git@h.example:22:a/b', 'https://h.example/a/../b', 'https://h.example:99999/a/b', 'ssh://-oProxyCommand=x@h.example/a/b', '-oProxyCommand@h.example:a/b', 'github-work:org/repo', 'https://h.example/repo',
      // git keeps a quoted space in the path it asks for.
      ' https://h.example/a/b', 'git@h.example:a/b.git ', 'git@h.example:a/b\n']) {
      expect(isOriginPin(bad), bad).toBe(false);
    }
    for (const u of ['https://h.example/a/b', 'ssh://git@h.example:2222/a/b', 'git@h.example:a/b']) {
      expect(isOriginPin(u), u).toBe(originUrlRepoKey(u) !== null);
    }
  });

  it('names a port other than the default only when it writes one', () => {
    const port = (u: string) => namesNonDefaultPort(parseOriginAddress(u) as NonNullable<ReturnType<typeof parseOriginAddress>>);
    expect(port('https://h.example/a/b')).toBe(false);
    expect(port('https://h.example:443/a/b')).toBe(false);
    expect(port('https://h.example:8443/a/b')).toBe(true);
    expect(port('ssh://git@h.example/a/b')).toBe(false);
    expect(port('ssh://git@h.example:22/a/b')).toBe(false);
    expect(port('ssh://git@h.example:2222/a/b')).toBe(true);
    expect(port('git@h.example:a/b')).toBe(false);
  });
});

describe('originPinMatches', () => {
  it('a self-hosted repository spelled App or app is one repository (the path case is ignored on every host)', () => {
    expect(originPinMatches('https://git.corp.example/team/App.git', 'https://git.corp.example/team/app.git')).toBe(true);
    expect(originPinMatches('git@git.corp.example:team/App.git', 'git@git.corp.example:Team/app')).toBe(true);
  });

  it('compares the port: 22 and 2222 are different servers, and an ssh address with no port is not :22', () => {
    expect(originPinMatches('ssh://git@git.corp.example:22/team/app.git', 'ssh://git@git.corp.example:2222/team/app.git')).toBe(false);
    expect(originPinMatches('ssh://git@git.corp.example/team/app.git', 'ssh://git@git.corp.example:2222/team/app.git')).toBe(false);
    expect(originPinMatches('https://git.corp.example/team/app', 'https://git.corp.example:8443/team/app')).toBe(false);
    expect(originPinMatches('ssh://git@git.corp.example/team/app.git', 'ssh://git@git.corp.example:22/team/app')).toBe(false);
    expect(originPinMatches('https://git.corp.example/team/app', 'https://git.corp.example:443/team/app.git')).toBe(true);
  });

  it('compares the host exactly', () => {
    expect(originPinMatches('https://github.com/acme/app', 'https://gitlab.com/acme/app')).toBe(false);
    expect(originPinMatches('git@github.com:acme/app', 'git@github.com.evil.example:acme/app')).toBe(false);
    expect(originPinMatches('https://github.com/acme/app', 'https://GitHub.com/acme/app')).toBe(true);
  });

  it('the transport and form must stay as recorded: https and ssh, scp-style and ssh:// are not interchangeable', () => {
    expect(originPinMatches('https://github.com/acme/app.git', 'git@github.com:acme/app.git')).toBe(false);
    expect(originPinMatches('git@github.com:acme/app.git', 'https://github.com/acme/app')).toBe(false);
    expect(originPinMatches('https://github.com/acme/app', 'ssh://git@github.com/acme/app')).toBe(false);
    expect(originPinMatches('git@git.corp.example:team/app', 'ssh://git@git.corp.example/team/app')).toBe(false);
  });

  it('between ssh addresses the user is kept as recorded', () => {
    expect(originPinMatches('git@git.corp.example:team/app', 'deploy@git.corp.example:team/app')).toBe(false);
    expect(originPinMatches('ssh://git@git.corp.example/team/app', 'ssh://git.corp.example/team/app')).toBe(false);
  });

  it('an ssh Host alias is a host name like any other: matched as written, never resolved', () => {
    expect(originPinMatches('git@github-work:org/repo.git', 'git@github-work:org/repo')).toBe(true);
    expect(originPinMatches('git@github-work:org/repo', 'git@github.com:org/repo')).toBe(false);
    expect(originPinMatches('git@github.com:org/repo', 'git@github-work:org/repo')).toBe(false);
    expect(originUrlRepoKey('git@github-work:org/repo')).toBe('github-work/org/repo');
  });

  it('never matches an address that is not plain', () => {
    expect(originPinMatches('https://github.com/acme/app', 'file:///github.com/acme/app')).toBe(false);
    expect(originPinMatches('not a pin', 'https://github.com/acme/app')).toBe(false);
  });

  it('the URLs git connects to are one endpoint under the same rules, else only when identical', () => {
    expect(sameOriginEndpoint('ssh://a.example/team/app', 'ssh://a.example/team/App.git')).toBe(true);
    expect(sameOriginEndpoint('ssh://a.example/team/app', 'ssh://b.example/team/app')).toBe(false);
    expect(sameOriginEndpoint('ssh://b.example/', 'ssh://b.example/')).toBe(true);
    expect(sameOriginEndpoint('ssh://b.example/', 'ssh://a.example/team/app')).toBe(false);
  });
});
