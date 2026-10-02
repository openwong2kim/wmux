// Held-input files: one small file per helper process in a private per-user
// directory, so the helper main starts after a kill can release what the dead
// one held. The files are untrusted input to a process that injects input, so:
//   - the directory is %LOCALAPPDATA%\wmux\computer-use\held, found through
//     SHGetKnownFolderPath (not the environment, which comes from the parent);
//   - it must be a real directory (no reparse point) owned by the current
//     user, with a protected DACL that grants only that user; a looser DACL
//     on a directory we own is replaced, anything else turns persistence off;
//   - files get the same protected owner-only DACL when written, are opened
//     without following reparse points (readers share delete, so a writer's
//     rename over them still succeeds), must be small regular files owned by
//     the user with that DACL, and go through HeldState.Parse, which
//     keeps only vocabulary keys, the modifiers and buttons 0–2;
//   - each file names its process by pid and creation time, so a recycled pid
//     is not mistaken for a live helper.

using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
using Windows.Win32;
using Windows.Win32.Foundation;
using Windows.Win32.Storage.FileSystem;
using Windows.Win32.UI.Shell;
using WmuxComputerUse.Core;

namespace WmuxComputerUse;

internal static unsafe class HeldStore
{
    private static readonly int SelfPid = Environment.ProcessId;
    private static readonly long SelfCreated = Win.CreationTime(PInvoke.GetCurrentProcess());
    private static readonly SecurityIdentifier? User = CurrentUser();
    private static readonly string? Dir = Prepare();

    /// <summary>The directory in use, or null when persistence is off.</summary>
    public static string? Directory => Dir;

    private static SecurityIdentifier? CurrentUser()
    {
        try
        {
            using var identity = WindowsIdentity.GetCurrent();
            return identity.User;
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static string? LocalAppData()
    {
        PWSTR path;
        var id = PInvoke.FOLDERID_LocalAppData;
        if (PInvoke.SHGetKnownFolderPath(&id, KNOWN_FOLDER_FLAG.KF_FLAG_DEFAULT, HANDLE.Null, &path).Failed) return null;
        try
        {
            return path.ToString();
        }
        finally
        {
            PInvoke.CoTaskMemFree(path.Value);
        }
    }

    /// <summary>
    /// A protected, user-only DACL. The owner is named only at creation:
    /// changing the owner of an existing object needs WRITE_OWNER, which an
    /// owner does not implicitly hold (and it is already the user, checked).
    /// </summary>
    private static DirectorySecurity PrivateSecurity(SecurityIdentifier user, bool withOwner)
    {
        var security = new DirectorySecurity();
        if (withOwner) security.SetOwner(user);
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        security.AddAccessRule(new FileSystemAccessRule(user, FileSystemRights.FullControl,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        return security;
    }

    private static FileSecurity PrivateFileSecurity(SecurityIdentifier user)
    {
        var security = new FileSecurity();
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        security.AddAccessRule(new FileSystemAccessRule(user, FileSystemRights.FullControl, AccessControlType.Allow));
        return security;
    }

    /// <summary>A protected DACL owned by `user` whose every entry allows `user` only.</summary>
    private static bool IsPrivate(FileSystemSecurity security, SecurityIdentifier user)
    {
        if (!security.AreAccessRulesProtected) return false;
        if (security.GetOwner(typeof(SecurityIdentifier)) is not SecurityIdentifier owner || owner != user) return false;
        foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier)))
        {
            if (rule.IdentityReference is not SecurityIdentifier sid || sid != user) return false;
            if (rule.AccessControlType != AccessControlType.Allow) return false;
        }
        return true;
    }

    private static string? Prepare()
    {
        try
        {
            var user = User;
            var root = LocalAppData();
            if (user == null || string.IsNullOrEmpty(root)) return Off("no per-user profile directory");
            var parent = new DirectoryInfo(Path.Combine(root, "wmux", "computer-use"));
            parent.Create();
            if (parent.Attributes.HasFlag(FileAttributes.ReparsePoint)) return Off("its parent is a reparse point");
            var dir = new DirectoryInfo(Path.Combine(parent.FullName, "held"));
            if (!dir.Exists) dir.Create(PrivateSecurity(user, withOwner: true));
            dir.Refresh();
            if (!dir.Exists || dir.Attributes.HasFlag(FileAttributes.ReparsePoint)) return Off("it is not a real directory");
            var security = dir.GetAccessControl();
            if (security.GetOwner(typeof(SecurityIdentifier)) is not SecurityIdentifier owner || owner != user)
            {
                return Off("it is owned by someone else");
            }
            if (!IsPrivate(security, user))
            {
                // Ours but too open (an older build, a copy): tighten it.
                dir.SetAccessControl(PrivateSecurity(user, withOwner: false));
                if (!IsPrivate(dir.GetAccessControl(), user)) return Off("its access list could not be made private");
            }
            return dir.FullName;
        }
        catch (Exception e)
        {
            return Off(e.GetType().Name);
        }
    }

    private static string? Off(string why)
    {
        Wire.Log($"held-input directory unusable ({why}); held keys will not survive a crash");
        return null;
    }

    private static string? OwnFile => Dir == null ? null : Path.Combine(Dir, $"{SelfPid}.json");

    public static void Write(IReadOnlyList<ushort> keys, IReadOnlyList<HeldButton> buttons)
    {
        var path = OwnFile;
        if (path == null) return;
        try
        {
            if (keys.Count == 0 && buttons.Count == 0)
            {
                File.Delete(path);
                return;
            }
            var data = new HeldState(SelfPid, SelfCreated, keys, buttons).Serialize();
            var tmp = path + ".tmp";
            var handle = Open(tmp, write: true);
            if (handle == null) return;
            using (var stream = new FileStream(handle, FileAccess.Write))
            {
                stream.SetAccessControl(PrivateFileSecurity(User!));
                stream.Write(data);
            }
            File.Move(tmp, path, overwrite: true);
        }
        catch (Exception e)
        {
            Wire.Log($"could not record held input: {e.GetType().Name}");
        }
    }

    public static void RemoveOwn()
    {
        var path = OwnFile;
        if (path == null) return;
        try
        {
            File.Delete(path);
        }
        catch (Exception)
        {
        }
    }

    public static void Remove(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch (Exception)
        {
        }
    }

    /// <summary>
    /// Records of this process and of helpers that are no longer running,
    /// sanitized. A record of a live helper (same pid and creation time) is
    /// left alone; unreadable or malformed files are deleted.
    /// </summary>
    public static List<(string Path, HeldState State)> ReadOrphaned()
    {
        var result = new List<(string, HeldState)>();
        if (Dir == null) return result;
        string[] files;
        try
        {
            files = System.IO.Directory.GetFiles(Dir, "*.json");
        }
        catch (Exception)
        {
            return result;
        }
        // A temp file left by a helper that died between writing and renaming.
        try
        {
            foreach (var tmp in System.IO.Directory.GetFiles(Dir, "*.json.tmp"))
            {
                var tmpPid = HeldState.PidFromFileName(Path.GetFileName(tmp)[..^4]);
                if (tmpPid is int tp && tp != SelfPid && Win.RunningCreationTime((uint)tp) is null) Remove(tmp);
            }
        }
        catch (Exception)
        {
        }
        foreach (var path in files)
        {
            var pid = HeldState.PidFromFileName(Path.GetFileName(path));
            if (pid is null) continue;
            var state = Read(path, pid.Value);
            if (state == null)
            {
                Remove(path);
                continue;
            }
            bool own = state.Pid == SelfPid && state.Created == SelfCreated;
            bool alive = !own && Win.RunningCreationTime((uint)state.Pid) is long created && created == state.Created;
            if (!alive) result.Add((path, state));
        }
        return result;
    }

    private static HeldState? Read(string path, int pid)
    {
        if (User == null) return null;
        try
        {
            var handle = Open(path, write: false);
            if (handle == null) return null;
            // The stream owns the handle from here on and closes it.
            using var stream = new FileStream(handle, FileAccess.Read);
            var attributes = File.GetAttributes(handle);
            if (attributes.HasFlag(FileAttributes.ReparsePoint) || attributes.HasFlag(FileAttributes.Directory)) return null;
            long length = RandomAccess.GetLength(handle);
            if (length <= 0 || length > HeldState.MaxFileBytes) return null;
            if (!IsPrivate(stream.GetAccessControl(), User)) return null;
            var data = new byte[length];
            int read = 0;
            while (read < data.Length)
            {
                int n = RandomAccess.Read(handle, data.AsSpan(read), read);
                if (n <= 0) return null;
                read += n;
            }
            return HeldState.Parse(data, pid);
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>Opens a file without following a reparse point; null when it cannot be opened.</summary>
    private static SafeFileHandle? Open(string path, bool write)
    {
        var handle = PInvoke.CreateFile(path,
            // WRITE_DAC: the writer sets the file's private DACL through this handle.
            write ? (uint)GENERIC_ACCESS_RIGHTS.GENERIC_WRITE | 0x00040000 /* WRITE_DAC */ : (uint)GENERIC_ACCESS_RIGHTS.GENERIC_READ,
            write ? 0 : FILE_SHARE_MODE.FILE_SHARE_READ | FILE_SHARE_MODE.FILE_SHARE_DELETE,
            null,
            write ? FILE_CREATION_DISPOSITION.CREATE_ALWAYS : FILE_CREATION_DISPOSITION.OPEN_EXISTING,
            FILE_FLAGS_AND_ATTRIBUTES.FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAGS_AND_ATTRIBUTES.FILE_ATTRIBUTE_NORMAL,
            null);
        if (handle.IsInvalid)
        {
            handle.Dispose();
            return null;
        }
        return handle;
    }
}
