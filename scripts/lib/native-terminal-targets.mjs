// The platforms the native terminal core is built for: the Rust target and
// the file name napi gives the built binary. scripts/build-native-terminal.mjs
// builds the host's entry.
export const NATIVE_TERMINAL_TARGETS = {
  'darwin-arm64': { target: 'aarch64-apple-darwin', binary: 'wmux-term.darwin-arm64.node' },
  'linux-x64': { target: 'x86_64-unknown-linux-gnu', binary: 'wmux-term.linux-x64-gnu.node' },
  'linux-arm64': { target: 'aarch64-unknown-linux-gnu', binary: 'wmux-term.linux-arm64-gnu.node' },
  'win32-x64': { target: 'x86_64-pc-windows-msvc', binary: 'wmux-term.win32-x64-msvc.node' },
};

export function nativeTerminalTarget(platform, arch) {
  const entry = NATIVE_TERMINAL_TARGETS[`${platform}-${arch}`];
  if (!entry) throw new Error(`Unqualified terminal-core target: ${platform}-${arch}`);
  return entry;
}
