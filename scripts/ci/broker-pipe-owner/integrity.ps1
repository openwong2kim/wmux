# Integrity-level helpers for run.ps1 (dot-sourced). Windows PowerShell 5.1.
#
#   [IntegrityLaunch]::Start(commandLine, cwd, integritySid)
#       starts a command line with the filtered (non-elevated) form of this
#       process's token, as UAC gives a standard process: CreateRestrictedToken
#       with LUA_TOKEN (the Administrators group deny-only, the admin
#       privileges removed), owned by the user with a default DACL for the user
#       and SYSTEM, then labelled with the given integrity level
#       (S-1-16-8192 Medium, S-1-16-4096 Low). Returns its pid. The child
#       inherits this process's environment. Its process handle is kept, so
#       the queries below and ExitState still answer after it exits.
#   [IntegrityLaunch]::ProcessIntegrity(pid)
#       the integrity RID of a running process (0x2000 Medium, 0x3000 High).
#   [IntegrityLaunch]::ProcessElevated(pid)
#       whether a running process's token is elevated (TokenElevation).
#   [IntegrityLaunch]::ExitState(pid)
#       'running', or the exit code in hex, of a process Start launched.
#
# Only for CI runners: run.ps1 calls Start only when it runs elevated there.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class IntegrityLaunch {
  [StructLayout(LayoutKind.Sequential)]
  struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }

  [StructLayout(LayoutKind.Sequential)]
  struct TOKEN_MANDATORY_LABEL { public SID_AND_ATTRIBUTES Label; }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize;
    public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags;
    public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
    public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }

  [StructLayout(LayoutKind.Sequential)]
  struct TOKEN_OWNER { public IntPtr Owner; }

  [StructLayout(LayoutKind.Sequential)]
  struct TOKEN_DEFAULT_DACL { public IntPtr DefaultDacl; }

  [DllImport("advapi32.dll", SetLastError = true, EntryPoint = "SetTokenInformation")]
  static extern bool SetTokenOwner(IntPtr token, int infoClass, ref TOKEN_OWNER info, int length);
  [DllImport("advapi32.dll", SetLastError = true, EntryPoint = "SetTokenInformation")]
  static extern bool SetTokenDefaultDacl(IntPtr token, int infoClass, ref TOKEN_DEFAULT_DACL info, int length);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl, uint revision, out IntPtr sd, out uint size);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool GetSecurityDescriptorDacl(IntPtr sd, out bool present, out IntPtr dacl, out bool defaulted);

  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr LocalFree(IntPtr mem);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool CreateRestrictedToken(IntPtr existing, uint flags, uint disableCount, IntPtr sidsToDisable,
    uint deleteCount, IntPtr privilegesToDelete, uint restrictedCount, IntPtr sidsToRestrict, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool ConvertStringSidToSid(string sid, out IntPtr psid);
  [DllImport("advapi32.dll")] static extern int GetLengthSid(IntPtr sid);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool SetTokenInformation(IntPtr token, int infoClass, ref TOKEN_MANDATORY_LABEL info, int length);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, int length, out int returned);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessAsUser(IntPtr token, string application, string commandLine, IntPtr processAttributes,
    IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string cwd, ref STARTUPINFO startup,
    out PROCESS_INFORMATION info);

  const uint TOKEN_ALL_ACCESS = 0xF01FF;
  const uint TOKEN_QUERY = 0x0008;
  const int TokenIntegrityLevel = 25;
  const int TokenElevation = 20;
  const int TokenOwner = 4;
  const int TokenDefaultDacl = 6;
  const uint LUA_TOKEN = 0x4;
  const uint SE_GROUP_INTEGRITY = 0x20;
  const uint CREATE_NO_WINDOW = 0x08000000;
  const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

  static Win32Exception Fail(string call) { return new Win32Exception(Marshal.GetLastWin32Error(), call); }

  // The handles of the processes Start launched, kept for the life of this
  // PowerShell process so a child that exits at once can still be inspected.
  static readonly Dictionary<int, IntPtr> launched = new Dictionary<int, IntPtr>();

  static IntPtr Open(int pid, out bool owned) {
    IntPtr held;
    if (launched.TryGetValue(pid, out held)) { owned = false; return held; }
    owned = true;
    IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (process == IntPtr.Zero) throw Fail("OpenProcess");
    return process;
  }

  public static string ExitState(int pid) {
    IntPtr held;
    if (!launched.TryGetValue(pid, out held)) return "not launched here";
    uint code;
    if (!GetExitCodeProcess(held, out code)) return "unknown (" + Marshal.GetLastWin32Error() + ")";
    return code == 259 ? "running" : "exit 0x" + code.ToString("x8");
  }

  public static int Start(string commandLine, string cwd, string integritySid) {
    IntPtr own = IntPtr.Zero, lowered = IntPtr.Zero, sid = IntPtr.Zero, user = IntPtr.Zero, daclSd = IntPtr.Zero;
    try {
      if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ALL_ACCESS, out own)) throw Fail("OpenProcessToken");
      // The filtered token of a UAC standard process: a restricted copy of
      // this primary token, so CreateProcessAsUser needs no extra privilege.
      if (!CreateRestrictedToken(own, LUA_TOKEN, 0, IntPtr.Zero, 0, IntPtr.Zero, 0, IntPtr.Zero, out lowered)) {
        throw Fail("CreateRestrictedToken");
      }
      // As UAC builds a filtered token: the user owns what the child creates,
      // and its default DACL grants the user and SYSTEM. Copied from this
      // elevated token, both name the Administrators group, which LUA_TOKEN
      // makes deny-only: the child could not open its own process and thread,
      // and failed its DLL initialization (0xc0000142).
      string userSid = System.Security.Principal.WindowsIdentity.GetCurrent().User.Value;
      if (!ConvertStringSidToSid(userSid, out user)) throw Fail("ConvertStringSidToSid");
      TOKEN_OWNER owner = new TOKEN_OWNER();
      owner.Owner = user;
      if (!SetTokenOwner(lowered, TokenOwner, ref owner, Marshal.SizeOf(owner))) throw Fail("SetTokenInformation(TokenOwner)");
      uint sdSize;
      if (!ConvertStringSecurityDescriptorToSecurityDescriptor("D:(A;;GA;;;" + userSid + ")(A;;GA;;;SY)", 1, out daclSd, out sdSize)) {
        throw Fail("ConvertStringSecurityDescriptorToSecurityDescriptor");
      }
      bool present, defaulted;
      IntPtr dacl;
      if (!GetSecurityDescriptorDacl(daclSd, out present, out dacl, out defaulted) || !present) throw Fail("GetSecurityDescriptorDacl");
      TOKEN_DEFAULT_DACL defaultDacl = new TOKEN_DEFAULT_DACL();
      defaultDacl.DefaultDacl = dacl;
      if (!SetTokenDefaultDacl(lowered, TokenDefaultDacl, ref defaultDacl, Marshal.SizeOf(defaultDacl))) {
        throw Fail("SetTokenInformation(TokenDefaultDacl)");
      }
      if (!ConvertStringSidToSid(integritySid, out sid)) throw Fail("ConvertStringSidToSid");
      TOKEN_MANDATORY_LABEL label = new TOKEN_MANDATORY_LABEL();
      label.Label.Sid = sid;
      label.Label.Attributes = SE_GROUP_INTEGRITY;
      if (!SetTokenInformation(lowered, TokenIntegrityLevel, ref label, Marshal.SizeOf(label) + GetLengthSid(sid))) {
        throw Fail("SetTokenInformation");
      }
      STARTUPINFO startup = new STARTUPINFO();
      startup.cb = Marshal.SizeOf(startup);
      PROCESS_INFORMATION info;
      if (!CreateProcessAsUser(lowered, null, commandLine, IntPtr.Zero, IntPtr.Zero, false, CREATE_NO_WINDOW,
          IntPtr.Zero, cwd, ref startup, out info)) {
        throw Fail("CreateProcessAsUser");
      }
      CloseHandle(info.hThread);
      launched[info.dwProcessId] = info.hProcess;
      return info.dwProcessId;
    } finally {
      if (sid != IntPtr.Zero) LocalFree(sid);
      if (user != IntPtr.Zero) LocalFree(user);
      if (daclSd != IntPtr.Zero) LocalFree(daclSd);
      if (lowered != IntPtr.Zero) CloseHandle(lowered);
      if (own != IntPtr.Zero) CloseHandle(own);
    }
  }

  public static bool ProcessElevated(int pid) {
    IntPtr process = IntPtr.Zero, held = IntPtr.Zero, token = IntPtr.Zero, buffer = IntPtr.Zero;
    try {
      bool owned;
      process = Open(pid, out owned);
      if (!owned) held = process;
      if (!OpenProcessToken(process, TOKEN_QUERY, out token)) throw Fail("OpenProcessToken");
      buffer = Marshal.AllocHGlobal(4);
      int length;
      if (!GetTokenInformation(token, TokenElevation, buffer, 4, out length)) throw Fail("GetTokenInformation");
      return Marshal.ReadInt32(buffer) != 0;
    } finally {
      if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);
      if (token != IntPtr.Zero) CloseHandle(token);
      if (process != IntPtr.Zero && process != held) CloseHandle(process);
    }
  }

  public static int ProcessIntegrity(int pid) {
    IntPtr process = IntPtr.Zero, held = IntPtr.Zero, token = IntPtr.Zero, buffer = IntPtr.Zero;
    try {
      bool owned;
      process = Open(pid, out owned);
      if (!owned) held = process;
      if (!OpenProcessToken(process, TOKEN_QUERY, out token)) throw Fail("OpenProcessToken");
      int length;
      GetTokenInformation(token, TokenIntegrityLevel, IntPtr.Zero, 0, out length);
      buffer = Marshal.AllocHGlobal(length);
      if (!GetTokenInformation(token, TokenIntegrityLevel, buffer, length, out length)) throw Fail("GetTokenInformation");
      IntPtr sid = Marshal.ReadIntPtr(buffer);
      int count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
      return Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1)));
    } finally {
      if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);
      if (token != IntPtr.Zero) CloseHandle(token);
      if (process != IntPtr.Zero && process != held) CloseHandle(process);
    }
  }
}
'@
