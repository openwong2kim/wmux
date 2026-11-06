//! File helpers with the Node bridges' semantics: the modes Node asks for on
//! create, and the same reads. Callers decide what an error means; most of
//! them, like the bridges, ignore it.

use std::fs;
use std::io::{self, Read, Seek, SeekFrom, Write};

/// `if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode })`, errors ignored.
pub fn ensure_dir(dir: &str, mode: u32) {
    if std::path::Path::new(dir).exists() {
        return;
    }
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, mode);
    #[cfg(not(unix))]
    let _ = mode;
    let _ = builder.create(dir);
}

/// `appendFileSync(path, bytes)`: creates the file when it is missing.
pub fn append(path: &str, bytes: &[u8]) -> io::Result<()> {
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?
        .write_all(bytes)
}

/// `writeFileSync(path, bytes, { mode })`: create or truncate; the mode
/// applies only to a file this call creates, as with Node.
pub fn write_file(path: &str, bytes: &[u8], mode: u32) -> io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, mode);
    #[cfg(not(unix))]
    let _ = mode;
    options.open(path)?.write_all(bytes)
}

/// `if (statSync(path).size > max) renameSync(path, path + '.1')`, replacing
/// an older `.1`. Errors (a missing file, a lost race) are ignored. True when
/// it rotated.
pub fn rotate_if_over(path: &str, max: u64) -> bool {
    match fs::metadata(path) {
        Ok(meta) if meta.len() > max => fs::rename(path, format!("{path}.1")).is_ok(),
        _ => false,
    }
}

/// `statSync(path).mtimeMs`.
pub fn mtime_ms(path: &str) -> io::Result<f64> {
    let modified = fs::metadata(path)?.modified()?;
    let since = modified
        .duration_since(std::time::UNIX_EPOCH)
        .map_or_else(|e| -e.duration().as_secs_f64(), |d| d.as_secs_f64());
    Ok(since * 1000.0)
}

/// The last `max` bytes of a file and the offset they start at, read the way
/// the bridge's transcript readers do: a buffer of `min(max, size)` zeroed
/// bytes, filled by reading from `size - len`. A file that shrinks between the
/// stat and the read leaves the rest zeroed, as Node's `readSync` does.
pub fn read_tail(path: &str, max: u64) -> io::Result<(Vec<u8>, u64)> {
    let mut file = fs::File::open(path)?;
    let size = file.metadata()?.len();
    let len = max.min(size);
    let offset = size - len;
    let mut buf = vec![0u8; len as usize];
    file.seek(SeekFrom::Start(offset))?;
    let mut filled = 0;
    while filled < buf.len() {
        match file.read(&mut buf[filled..])? {
            0 => break,
            n => filled += n,
        }
    }
    Ok((buf, offset))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> String {
        let dir = std::env::temp_dir().join(format!("wmux-fsx-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.to_string_lossy().into_owned()
    }

    #[test]
    fn ensure_dir_creates_parents_with_the_mode() {
        let root = temp_dir("dir");
        let dir = format!("{root}/a/b");
        ensure_dir(&dir, 0o700);
        assert!(std::path::Path::new(&dir).is_dir());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        }
        // An existing directory is left alone.
        ensure_dir(&dir, 0o755);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn append_creates_then_appends() {
        let root = temp_dir("append");
        let file = format!("{root}/bridge.log");
        append(&file, b"one\n").unwrap();
        append(&file, b"two\n").unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"one\ntwo\n");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn write_file_sets_the_mode_on_create_only() {
        let root = temp_dir("write");
        let file = format!("{root}/stamp");
        write_file(&file, b"abc", 0o600).unwrap();
        write_file(&file, b"", 0o644).unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rotation_happens_only_past_the_cap_and_replaces_the_old_generation() {
        let root = temp_dir("rotate");
        let file = format!("{root}/bridge.log");
        fs::write(&file, b"12345").unwrap();
        assert!(!rotate_if_over(&file, 5), "exactly at the cap stays");
        fs::write(format!("{file}.1"), b"old").unwrap();
        fs::write(&file, b"123456").unwrap();
        assert!(rotate_if_over(&file, 5));
        assert!(!std::path::Path::new(&file).exists());
        assert_eq!(fs::read(format!("{file}.1")).unwrap(), b"123456");
        assert!(!rotate_if_over(&format!("{root}/missing"), 0));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn mtime_follows_the_file() {
        let root = temp_dir("mtime");
        let file = format!("{root}/stamp");
        fs::write(&file, b"").unwrap();
        let when = std::time::SystemTime::now() - std::time::Duration::from_millis(5000);
        fs::File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(when)
            .unwrap();
        let expected = when.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs_f64() * 1000.0;
        assert!((mtime_ms(&file).unwrap() - expected).abs() < 1.0);
        assert!(mtime_ms(&format!("{root}/missing")).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn read_tail_returns_the_end_and_its_offset() {
        let root = temp_dir("tail");
        let file = format!("{root}/t.jsonl");
        fs::write(&file, b"0123456789").unwrap();
        assert_eq!(read_tail(&file, 4).unwrap(), (b"6789".to_vec(), 6));
        assert_eq!(read_tail(&file, 64).unwrap(), (b"0123456789".to_vec(), 0));
        assert!(read_tail(&format!("{root}/missing"), 4).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
