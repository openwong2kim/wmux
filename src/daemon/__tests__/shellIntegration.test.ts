import { describe, it, expect } from 'vitest';
import { classifyShell, buildSpawnInjection, ZSH_RC, PWSH_INIT, BASH_INIT } from '../shell-integration';

// zsh 지원(macOS 기본 셸) — ZDOTDIR 가로채기 방식의 핵심 불변식 검증.
describe('classifyShell', () => {
  it('zsh를 분류한다 (경로/이름/로그인 셸 형태)', () => {
    expect(classifyShell('/bin/zsh')).toBe('zsh');
    expect(classifyShell('zsh')).toBe('zsh');
    expect(classifyShell('-zsh')).toBe('zsh'); // 로그인 셸은 argv[0]에 '-' 접두
  });

  it('기존 셸 분류는 그대로 유지한다', () => {
    expect(classifyShell('/bin/bash')).toBe('bash');
    expect(classifyShell('pwsh')).toBe('pwsh');
    expect(classifyShell('powershell.exe')).toBe('pwsh');
    expect(classifyShell('/usr/bin/fish')).toBeNull();
    expect(classifyShell('')).toBeNull();
  });
});

describe('buildSpawnInjection — zsh', () => {
  it('zsh는 ZDOTDIR을 wmux zsh 디렉토리로 설정한다', () => {
    const inj = buildSpawnInjection('/bin/zsh');
    expect(inj).not.toBeNull();
    // ZDOTDIR 가로채기: wmux 디렉토리를 가리켜야 OSC 133 stub이 로드된다.
    expect(inj?.env.ZDOTDIR).toMatch(/shell-integration[\\/]zsh$/);
    expect(inj?.env.WMUX_SHELL_INTEGRATION).toBe('1');
    expect(inj?.args).toContain('-i');
    // #519 — macOS builds its standard PATH in /etc/zprofile via path_helper,
    // and zprofile is a LOGIN file. Interactive-only left panes without
    // /opt/homebrew/bin, /usr/sbin, /sbin and every /etc/paths.d entry, so an
    // unqualified Homebrew command failed even though .zshrc had run.
    // Linux terminals default to non-login; adding -l there would newly source
    // /etc/profile for existing users with no bug behind it.
    if (process.platform === 'darwin') {
      expect(inj?.args).toContain('-l');
      expect(inj?.args).toEqual(['-l', '-i']);
    } else {
      expect(inj?.args).not.toContain('-l');
    }
  });

  it('알 수 없는 셸은 injection이 없다(일반 spawn)', () => {
    expect(buildSpawnInjection('/usr/bin/fish')).toBeNull();
    expect(buildSpawnInjection('cmd.exe')).toBeNull();
  });
});

// OSC 133 B 마커는 반드시 zsh의 %{...%} 제로폭 가드로 감싸야 한다.
// 가드 없이 raw escape를 PROMPT에 붙이면 zle가 8바이트를 표시 폭으로
// 오계산 → resize 스윕 중 zrefresh/resetvideo가 SIGBUS로 크래시한다 (RCA 2026-07-05).
describe('ZSH_RC — PROMPT B 마커 폭 가드', () => {
  it('133;B 마커를 %{ ... %} 안에 감싼다', () => {
    // %{ 와 그 다음 %} 사이에 133;B 가 있어야 한다 (사이에 다른 % 프롬프트 이스케이프 없음).
    expect(ZSH_RC).toMatch(/%\{[^%]*133;B[^%]*%\}/);
  });

  it('가드를 씌워도 마커 자체는 여전히 방출된다', () => {
    // 회귀 방지: 폭 가드 때문에 마커가 통째로 사라지면 OSC 133 인덱싱이 깨진다.
    expect(ZSH_RC).toContain('133;B');
    // 가드 없는 옛 형태(PROMPT="${PROMPT}"$'...133;B)가 남아있지 않아야 한다.
    expect(ZSH_RC).not.toMatch(/"\$\{PROMPT\}"\$'\\033\]133;B/);
  });
});

// v6: mac 기본 zsh가 cd를 보고하지 않아 사이드바 브랜치/git 컨텍스트가 생성
// 시점 cwd에 고정되던 문제 수정(owner-reported 2026-07-19).
describe('ZSH_RC — OSC 7 cwd 보고', () => {
  it('OSC 7을 방출하는 __wmux_osc7 함수를 정의한다', () => {
    expect(ZSH_RC).toContain('__wmux_osc7()');
    // ESC]7;file://<host><PWD>BEL — parseOsc7Cwd와 맞춰 host 뒤 슬래시 없이
    // $PWD(절대경로)를 붙인다. `%s/%s`(이중 슬래시)는 //Users/... 를 만들어 금지.
    expect(ZSH_RC).toMatch(/__wmux_osc7\(\) \{ printf '\\033\]7;file:\/\/%s%s\\a' "\$\{HOST-localhost\}" "\$PWD"; \}/);
    expect(ZSH_RC).not.toContain('file://%s/%s');
  });

  it('chpwd(cd 즉시)와 precmd(최초/매 프롬프트)에 모두 등록한다', () => {
    expect(ZSH_RC).toMatch(/add-zsh-hook chpwd __wmux_osc7/);
    expect(ZSH_RC).toMatch(/add-zsh-hook precmd __wmux_osc7/);
    // add-zsh-hook 미존재 폴백 경로도 chpwd_functions에 등록해야 한다.
    expect(ZSH_RC).toMatch(/chpwd_functions\+=\(__wmux_osc7\)/);
  });
});

// Issue #540: the daemon's OSC 7-sticky permanently disables prompt scraping
// on the FIRST OSC 7, assuming the integration hook re-emits it on every
// prompt. v6/v7 made that true only for zsh — on pwsh/bash a single stray
// OSC 7 from any child program killed the only cwd source, freezing the
// tracked cwd at the spawn value (usually home) so splits landed in home
// (regressed #515). v8 gives pwsh/bash the same authoritative emitter.
describe('PWSH_INIT — OSC 7 cwd report (#540)', () => {
  it('emits OSC 7 from the prompt function on every prompt', () => {
    expect(PWSH_INIT).toContain(']7;file://');
    // The emission must live INSIDE the prompt function (re-emitted every
    // prompt), not as a one-shot at init — the sticky depends on re-emission.
    const promptBody = PWSH_INIT.slice(PWSH_INIT.indexOf('function global:prompt'));
    expect(promptBody).toContain(']7;file://');
  });

  it('emits only for the FileSystem provider (registry/cert locations have no directory)', () => {
    expect(PWSH_INIT).toMatch(/Provider\.Name -eq 'FileSystem'/);
  });

  it("splits on '\\' and joins with '/' to honor parseOsc7Cwd's /C:/Users/... contract", () => {
    // Regex split on a literal backslash: the .ps1 must read -split '\\'
    // (an escaped backslash — a bare '\' is an invalid regex and errors on
    // every prompt).
    expect(PWSH_INIT).toContain("-split '\\\\'");
    expect(PWSH_INIT).toContain("-join '/'");
    // The host/path separator must produce file://HOST/C:/... (single slash
    // between host and the converted path).
    expect(PWSH_INIT).toContain(']7;file://$env:COMPUTERNAME/$osc7Path');
  });

  it('percent-encodes each path segment so parseOsc7Cwd decode round-trips (#541 review)', () => {
    // parseOsc7Cwd decodeURIComponent()s the payload — a raw literal '%' in a
    // directory name would be corrupted unless the emitter escapes it.
    expect(PWSH_INIT).toContain('[Uri]::EscapeDataString');
    // The encode must run per segment (after the '\' split), never on the
    // whole path — encoding the whole path would escape the '/' separators.
    expect(PWSH_INIT).toMatch(/-split '\\\\' \| ForEach-Object \{ \[Uri\]::EscapeDataString\(\$_\) \}/);
  });
});

describe('BASH_INIT — OSC 7 cwd report (#540)', () => {
  it('defines __wmux_osc7 and calls it from precmd (every prompt)', () => {
    expect(BASH_INIT).toContain('__wmux_osc7()');
    expect(BASH_INIT).toContain(']7;file://');
    // precmd body must invoke the OSC 7 hook so it re-emits on every prompt.
    expect(BASH_INIT).toMatch(/__wmux_precmd\(\) \{[^}]*__wmux_osc7[^}]*\}/);
  });

  it('keeps the same payload contract as zsh (no double slash after host)', () => {
    expect(BASH_INIT).toContain("printf '\\033]7;file://%s%s\\a'");
    expect(BASH_INIT).not.toContain('file://%s/%s');
  });

  it('rewrites /c/Users → /c:/Users only under Git Bash (MSYSTEM set)', () => {
    // The rewrite must be gated on MSYSTEM — on real Linux, /c/foo is a
    // legitimate directory and must pass through untouched.
    expect(BASH_INIT).toMatch(/if \[ -n "\$\{MSYSTEM:-\}" \]/);
    expect(BASH_INIT).toMatch(/\/\[A-Za-z\]\/\*\)/);
  });

  it('percent-encodes the path so raw %, ESC and BEL bytes cannot corrupt or escape the sequence (#541 review)', () => {
    // parseOsc7Cwd decodeURIComponent()s the payload: a literal '%' in a
    // directory name must arrive as %25. Worse, a raw ESC/BEL byte in a
    // directory name would TERMINATE the OSC 7 early and let the remaining
    // pathname bytes inject arbitrary terminal escape sequences — the encoder
    // is the injection barrier, so the emitter must never printf $PWD (or its
    // MSYSTEM rewrite) raw.
    expect(BASH_INIT).toContain('__wmux_osc7_encode()');
    // Byte-wise walk (LC_ALL=C), '/' passes through, everything outside the
    // unreserved set becomes %XX.
    expect(BASH_INIT).toContain('local LC_ALL=C LC_CTYPE=C');
    expect(BASH_INIT).toMatch(/\[a-zA-Z0-9.\/~_-\]\) out\+="\$c"/);
    expect(BASH_INIT).toMatch(/printf -v hex '%02X' "'\$c"/);
    // The emitter consumes the ENCODED path, not the raw one.
    expect(BASH_INIT).toContain('"$(__wmux_osc7_encode "$p")"');
    // And no emission path passes the raw $p to printf anymore.
    expect(BASH_INIT).not.toContain('"${HOSTNAME-localhost}" "$p"');
  });
});
