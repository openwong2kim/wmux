// Adapted from MonoCode (hardbeat920/monocode@6bd432ca, src/shared/lib/paths.ts), MIT License, Copyright (c) 2026 Nick
//
// Only the display helpers the transcript fold needs. Shared by the daemon and
// the renderer, so there is no platform probe: a path is treated as Windows by
// its own shape.

function windowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\") || path.startsWith("//");
}

export function slash(path: string): string {
  return windowsPath(path) ? path.replace(/\\/g, "/") : path;
}

function trimSlash(path: string): string {
  return slash(path).replace(/\/+$/, "") || "/";
}

/** Stable comparison key for Windows paths without changing their display case. */
export function pathKey(path: string): string {
  const normalized = trimSlash(path);
  return /^[A-Za-z]:(?:\/|$)/.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}

/** Path relative to cwd when it lives under the project, otherwise unchanged. */
export function displayPath(path: string, cwd?: string): string {
  const normalized = trimSlash(path);
  const base = cwd ? trimSlash(cwd) : undefined;
  if (base && base !== "~") {
    const key = pathKey(normalized);
    const baseKey = pathKey(base);
    if (key === baseKey) {
      return normalized.split("/").filter(Boolean).pop() || normalized;
    }
    const prefix = `${base}/`;
    if (key.startsWith(`${baseKey}/`)) {
      return normalized.slice(prefix.length);
    }
  }
  return normalized;
}
