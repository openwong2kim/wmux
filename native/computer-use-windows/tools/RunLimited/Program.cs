// RunLimited [--no-wait] <exe> [args...]
//
// Starts <exe> with a de-elevated copy of this process's token: a restricted
// token (DISABLE_MAX_PRIVILEGE | LUA_TOKEN) labelled Medium integrity. The
// child inherits this process's standard handles, so pipes from the caller
// (node's spawn) reach it. Waits and exits with the child's exit code, or with
// --no-wait prints the child's pid on stdout and exits 0.
//
// CI only (hosted Windows runners run jobs as an elevated administrator, and
// the helper refuses to run elevated). Not shipped.

using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

internal static unsafe class Program
{
    private const uint TOKEN_QUERY = 0x0008, TOKEN_DUPLICATE = 0x0002, TOKEN_ASSIGN_PRIMARY = 0x0001, TOKEN_ADJUST_DEFAULT = 0x0080;
    private const uint DISABLE_MAX_PRIVILEGE = 0x1, LUA_TOKEN = 0x4;
    private const int TokenElevation = 20, TokenIntegrityLevel = 25;
    private const uint SE_GROUP_INTEGRITY = 0x20;
    private const int STARTF_USESTDHANDLES = 0x100;
    private const uint HANDLE_FLAG_INHERIT = 1;
    private const uint INFINITE = 0xFFFFFFFF;

    [StructLayout(LayoutKind.Sequential)]
    private struct SID_AND_ATTRIBUTES { public nint Sid; public uint Attributes; }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFOW
    {
        public int cb; public nint lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2; public nint lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION { public nint hProcess, hThread; public int dwProcessId, dwThreadId; }

    [DllImport("kernel32.dll")] private static extern nint GetCurrentProcess();
    [DllImport("kernel32.dll")] private static extern nint GetStdHandle(int n);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetHandleInformation(nint h, uint mask, uint flags);
    [DllImport("kernel32.dll")] private static extern uint WaitForSingleObject(nint h, uint ms);
    [DllImport("kernel32.dll")] private static extern bool GetExitCodeProcess(nint h, out uint code);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(nint h);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(nint p, uint access, out nint token);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool CreateRestrictedToken(nint existing, uint flags, uint disableSidCount, nint sidsToDisable,
        uint deletePrivilegeCount, nint privilegesToDelete, uint restrictedSidCount, nint sidsToRestrict, out nint newToken);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool ConvertStringSidToSidW(string sid, out nint psid);
    [DllImport("advapi32.dll")] private static extern uint GetLengthSid(nint psid);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool SetTokenInformation(nint token, int cls, void* info, uint len);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetTokenInformation(nint token, int cls, void* info, uint len, out uint ret);
    [DllImport("advapi32.dll")] private static extern uint* GetSidSubAuthority(nint sid, uint n);
    [DllImport("advapi32.dll")] private static extern byte* GetSidSubAuthorityCount(nint sid);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessAsUserW(nint token, string? app, StringBuilder cmd, nint pa, nint ta, bool inherit,
        uint flags, nint env, string? cwd, ref STARTUPINFOW si, out PROCESS_INFORMATION pi);

    private static int Main(string[] argv)
    {
        bool noWait = argv.Length > 0 && argv[0] == "--no-wait";
        var rest = noWait ? argv[1..] : argv;
        if (rest.Length == 0)
        {
            Console.Error.WriteLine("usage: RunLimited [--no-wait] <exe> [args...]");
            return 2;
        }
        try
        {
            if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT, out var self)) Fail("OpenProcessToken");
            if (!CreateRestrictedToken(self, DISABLE_MAX_PRIVILEGE | LUA_TOKEN, 0, 0, 0, 0, 0, 0, out var token)) Fail("CreateRestrictedToken");
            if (!ConvertStringSidToSidW("S-1-16-8192", out var medium)) Fail("ConvertStringSidToSid");
            var label = new SID_AND_ATTRIBUTES { Sid = medium, Attributes = SE_GROUP_INTEGRITY };
            if (!SetTokenInformation(token, TokenIntegrityLevel, &label, (uint)sizeof(SID_AND_ATTRIBUTES) + GetLengthSid(medium))) Fail("SetTokenInformation(TokenIntegrityLevel)");
            Console.Error.WriteLine($"[RunLimited] child token: integrity 0x{Integrity(token):x}, elevated {Elevated(token)}");

            // The caller's pipes must be inheritable to reach the child.
            var si = new STARTUPINFOW { cb = sizeof(STARTUPINFOW), dwFlags = STARTF_USESTDHANDLES };
            si.hStdInput = Inheritable(GetStdHandle(-10));
            si.hStdOutput = Inheritable(GetStdHandle(-11));
            si.hStdError = Inheritable(GetStdHandle(-12));
            var cmd = new StringBuilder(string.Join(' ', rest.Select(Quote)));
            if (!CreateProcessAsUserW(token, null, cmd, 0, 0, true, 0, 0, null, ref si, out var pi)) Fail("CreateProcessAsUser");
            CloseHandle(pi.hThread);
            if (noWait)
            {
                Console.Out.WriteLine(pi.dwProcessId);
                Console.Out.Flush();
                CloseHandle(pi.hProcess);
                return 0;
            }
            WaitForSingleObject(pi.hProcess, INFINITE);
            GetExitCodeProcess(pi.hProcess, out var code);
            CloseHandle(pi.hProcess);
            return (int)code;
        }
        catch (Win32Exception e)
        {
            Console.Error.WriteLine($"[RunLimited] {e.Message}");
            return 125;
        }
    }

    private static nint Inheritable(nint h)
    {
        if (h != 0 && h != -1) SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
        return h;
    }

    private static void Fail(string what) => throw new Win32Exception(Marshal.GetLastWin32Error(), $"{what} failed (error {Marshal.GetLastWin32Error()})");

    private static uint Integrity(nint token)
    {
        byte* buf = stackalloc byte[256];
        if (!GetTokenInformation(token, TokenIntegrityLevel, buf, 256, out _)) return 0;
        var sid = ((SID_AND_ATTRIBUTES*)buf)->Sid;
        return *GetSidSubAuthority(sid, (uint)(*GetSidSubAuthorityCount(sid) - 1));
    }

    private static bool Elevated(nint token)
    {
        uint elevated;
        return GetTokenInformation(token, TokenElevation, &elevated, 4, out _) && elevated != 0;
    }

    /// <summary>Quotes one argument by the CommandLineToArgvW rules.</summary>
    private static string Quote(string arg)
    {
        if (arg.Length > 0 && arg.IndexOfAny([' ', '\t', '"']) < 0) return arg;
        var sb = new StringBuilder("\"");
        int slashes = 0;
        foreach (var c in arg)
        {
            if (c == '\\') { slashes++; continue; }
            sb.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            slashes = 0;
            sb.Append(c);
        }
        sb.Append('\\', slashes * 2).Append('"');
        return sb.ToString();
    }
}
