// PR 표면 provider 계약 — Git 탭의 PR 목록·코멘트가 소비하는 정규화 타입.
//
// 구현체: GhPrService(GitHub, gh CLI) + GlabPrService(GitLab, glab CLI).
// provider 선택은 origin remote의 hostname으로 한다: github.com 계열 → gh,
// 그 외 모든 호스트 → glab 경로(gitlab.com만이 아니라 self-hosted GitLab이
// 흔하므로 hostname 화이트리스트가 아니라 "github이 아니면 glab에게 물어본다"
// — glab 미설치/그 호스트 미인증이면 fail-closed 안내로 강등).
import { git } from '../git/git';
import { configuredForge, dropGlabSubfolder, forgeHosts, type ForgeHosts } from '../../shared/forgeHosts';
import type { PrSummary, PrComment, PrDetail } from '../../shared/prSurface';

// wire 타입은 shared/prSurface.ts가 정본(렌더러와 공유). 여기서 재노출해
// main 쪽 소비자(구현체/핸들러)의 import 표면을 한 곳으로 유지한다.
export type { PrSummary, PrComment, PrDetail };
export { PR_COMMENT_BODY_CAP } from '../../shared/prSurface';

export type PrGate =
  | { ok: true }
  | { ok: false; reason: 'cli-missing' | 'unauthenticated'; message: string };

export type PrListResult = { ok: true; prs: PrSummary[] } | { ok: false; error: string };
export type PrDetailResult = { ok: true; detail: PrDetail } | { ok: false; error: string };

/** 호스트 중립 provider 계약. `host`는 remote hostname — GitLab은 인증이
 *  호스트 단위(`glab auth status --hostname`, self-hosted)라 게이트에 필요하다.
 *  gh 구현은 무시한다. */
export interface PrProvider {
  /** CLI 존재·인증 게이트. 실패는 사용자 안내 문구를 담아 fail-closed.
   *  `force` (an explicit "Check again") skips the gate's TTL caches. */
  gate(repoPath: string, host: string, force?: boolean): Promise<PrGate>;
  /** force=true는 수동 새로고침 — 구현체의 TTL 캐시를 건너뛴다. `key` is the
   *  remote's identity (host/owner/repo), so clones of one repo share a fetch. */
  listPrs(repoPath: string, force?: boolean, key?: string): Promise<PrListResult>;
  prDetail(repoPath: string, number: number, updatedAt: string, key?: string): Promise<PrDetailResult>;
}

/** CLI(gh/glab) 실행용 PATH — macOS GUI 실행은 launchd PATH를 상속해
 *  Homebrew 경로(/opt/homebrew/bin, /usr/local/bin)가 빠진다. execFile이
 *  바이너리를 못 찾아 cli-missing으로 강등되는 것을 막기 위해 보강한다. */
export function cliPath(): string {
  const base = process.env.PATH ?? '';
  if (process.platform !== 'darwin') return base;
  const extras = ['/opt/homebrew/bin', '/usr/local/bin'].filter(
    (p) => !base.split(':').includes(p),
  );
  return extras.length ? `${base}:${extras.join(':')}` : base;
}

/** origin remote URL → hostname. 원격 없음/파싱 불가는 null. 순수(테스트용). */
export function parseRemoteHost(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  // https://host/o/r(.git) | git@host:o/r.git | ssh://git@host/o/r
  const m = trimmed.match(/^(?:https?:\/\/(?:[^@/]+@)?|git@|ssh:\/\/(?:[^@/]+@)?)([^/:]+)/i);
  const host = m?.[1]?.toLowerCase() ?? '';
  return host || null;
}

/** A GitHub host: github.com and its subdomains, GitHub Enterprise Cloud
 *  (`*.ghe.com`), a host with a label that is exactly `github` (GHES, e.g.
 *  `github.acme.com`), and a dotless SSH host alias that names github
 *  (`github-work`, which gh resolves itself). Every other host is GitLab. Pure. */
export function isGithubHost(host: string): boolean {
  return host === 'github.com' || host.endsWith('.github.com') || host.endsWith('.ghe.com')
    || /(?:^|\.)github(?:\.|$)/.test(host) || (!host.includes('.') && host.includes('github'));
}

/** Whether gh, not glab, serves `host`: what the CLIs' own config says
 *  (shared/forgeHosts.ts — GitHub Enterprise on its own domain is a host gh
 *  is signed in to), else isGithubHost's name rule. Every gh-or-glab
 *  routing decision goes through this. */
export function isGithubForgeHost(host: string): boolean {
  const forge = configuredForge(host, forgeHosts());
  return forge ? forge === 'github' : isGithubHost(host);
}

/** repo의 origin hostname — remote 없으면 null. */
export async function detectRemoteHost(repoPath: string): Promise<string | null> {
  const r = await git(['remote', 'get-url', 'origin'], repoPath);
  if (r.code !== 0) return null;
  return parseRemoteHost(r.stdout);
}

/**
 * A remote's identity, `host/owner/repo` lowercased, from its URL (https,
 * scp-style or ssh; a trailing `.git` dropped). Two clones of one repo get the
 * same key. null when the URL has no owner/repo path. An http(s) URL of a
 * GitLab served under a sub-path loses the subfolder glab's config names for
 * its host (shared/forgeHosts.ts dropGlabSubfolder), so the key's path is the
 * project's, as an ssh clone of it spells it. Pure but for that config read.
 */
export function parseRemoteKey(url: string, hosts: ForgeHosts = forgeHosts()): string | null {
  const host = parseRemoteHost(url);
  if (!host) return null;
  const path = url.trim()
    .replace(/^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?)[^/]+\//i, '')
    .replace(/^git@[^:]+:/i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  const parts = path.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const kept = /^https?:\/\//i.test(url.trim()) ? dropGlabSubfolder(host, parts, hosts) : parts;
  return `${host}/${kept.join('/')}`.toLowerCase();
}

export interface RemoteIdentity { host: string; key: string | null }

const REMOTE_TTL_MS = 60_000;
const remoteCache = new Map<string, { value: RemoteIdentity | null; at: number }>();

/** origin's host and key, cached per repo path for a minute (`force` re-reads). */
export async function detectRemote(repoPath: string, force = false, now: () => number = Date.now): Promise<RemoteIdentity | null> {
  const hit = remoteCache.get(repoPath);
  if (!force && hit && now() - hit.at < REMOTE_TTL_MS) return hit.value;
  const r = await git(['remote', 'get-url', 'origin'], repoPath);
  const host = r.code === 0 ? parseRemoteHost(r.stdout) : null;
  const value = host ? { host, key: parseRemoteKey(r.stdout) } : null;
  remoteCache.set(repoPath, { value, at: now() });
  if (remoteCache.size > 256) remoteCache.delete(remoteCache.keys().next().value as string);
  return value;
}

/** Whether `origin` is set at all: a repo detectRemote finds no remote for
 *  may still have one that names no host (a local path), which wants
 *  `git remote set-url` rather than `git remote add`. */
export async function originUrlSet(repoPath: string): Promise<boolean> {
  const r = await git(['remote', 'get-url', 'origin'], repoPath).catch(() => null);
  return !!r && r.code === 0 && r.stdout.trim() !== '';
}

/** Test seam. */
export function clearRemoteCache(): void {
  remoteCache.clear();
}
