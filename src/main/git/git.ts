// 공용 git 실행 헬퍼 — diff.handler(J2)의 git()을 승격 추출(동작 무변경).
// cwd 고정, 타임아웃·버퍼 캡. throw 대신 stdout/stderr/code 반환 계약:
// 호출부가 git 실패를 표시용 에러로 강등할 수 있어야 하므로(fail-soft 표면),
// execFile의 throw를 여기서 흡수한다.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getExecEnv } from '../../shared/execEnv';

const execFileAsync = promisify(execFile);

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export async function git(args: string[], cwd: string): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      timeout: 30000,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      env: getExecEnv(),
    });
    return { stdout, stderr, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? String(e),
      code: typeof err.code === 'number' ? err.code : 1,
    };
  }
}
