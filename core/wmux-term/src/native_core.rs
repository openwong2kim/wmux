//! Opt-in native terminal core: VT state and retained history behind N-API.
//! NativeTransport owns the production PTY; NativePty remains a spike harness.

use crate::native_output::NativeOutputChunk;
use alacritty_terminal::event::VoidListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::{Config, Osc52, Term, TermMode};
use alacritty_terminal::vte::ansi::{Processor, Timeout};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::mpsc::{sync_channel, Receiver, TryRecvError};
use std::sync::{Arc, Mutex};

/// Loader contract for the opt-in daemon text backend. Bump on incompatible
/// changes to the exposed snapshot shape or required compatibility policy.
#[napi]
pub fn native_core_abi_version() -> u32 {
    1
}

#[napi]
pub fn native_core_capabilities() -> Vec<String> {
    vec![
        "text-v1".into(),
        "ring-v1".into(),
        "pty-v1".into(),
        "frozen-ring-v1".into(),
        "output-chunk-v1".into(),
        "output-interpreter-v1".into(),
        "ansi-v2".into(),
        "console-owner-v1".into(),
    ]
}

struct Size {
    cols: usize,
    rows: usize,
}
impl Dimensions for Size {
    fn total_lines(&self) -> usize {
        self.rows
    }
    fn screen_lines(&self) -> usize {
        self.rows
    }
    fn columns(&self) -> usize {
        self.cols
    }
}

fn dimensions(cols: u32, rows: u32) -> Result<Size> {
    if !(2..=1000).contains(&cols) || !(1..=1000).contains(&rows) {
        return Err(Error::from_reason(
            "Experiment requires 2..1000 columns and 1..1000 rows",
        ));
    }
    Ok(Size {
        cols: cols as usize,
        rows: rows as usize,
    })
}

#[napi(object)]
pub struct NativeTextRow {
    pub text: String,
    pub wrapped: bool,
    pub undimmed: Option<String>,
}

#[napi(object)]
pub struct NativeTextSnapshot {
    pub rows: Vec<NativeTextRow>,
    pub buffer_type: String,
    pub rows_below_cursor: u32,
}

#[napi]
pub struct NativeTerminal {
    term: Option<Term<VoidListener>>,
    parser: Processor,
    scrollback: u32,
}

#[napi]
impl NativeTerminal {
    #[napi(constructor)]
    pub fn new(cols: u32, rows: u32, scrollback: u32) -> Result<Self> {
        let size = dimensions(cols, rows)?;
        if scrollback > 100_000 || (rows as u64 + scrollback as u64) * cols as u64 > 4_000_000 {
            return Err(Error::from_reason(
                "Experiment grid exceeds four million cells",
            ));
        }
        let config = Config {
            scrolling_history: scrollback as usize,
            osc52: Osc52::Disabled,
            ..Config::default()
        };
        Ok(Self {
            term: Some(Term::new(config, &size, VoidListener)),
            parser: Processor::new(),
            scrollback,
        })
    }

    #[napi]
    pub fn feed(&mut self, bytes: Uint8Array) -> Result<()> {
        let term = self
            .term
            .as_mut()
            .ok_or_else(|| Error::from_reason("Terminal disposed"))?;
        // Parser retains incomplete UTF-8 / escape state across feeds.
        // VoidListener intentionally discards all PTY replies and clipboard events.
        self.parser.advance(term, &bytes);
        Ok(())
    }

    /// Replay an immutable native ring copy without a full JS Buffer round trip.
    #[napi]
    pub fn feed_frozen(&mut self, source: &NativeFrozenRing, start: u32, end: u32) -> Result<()> {
        let bytes = source
            .bytes
            .get(start as usize..end as usize)
            .ok_or_else(|| Error::from_reason("Invalid frozen ring range"))?;
        let term = self
            .term
            .as_mut()
            .ok_or_else(|| Error::from_reason("Terminal disposed"))?;
        self.parser.advance(term, bytes);
        Ok(())
    }

    #[napi]
    pub fn resize(&mut self, cols: u32, rows: u32) -> Result<()> {
        let size = dimensions(cols, rows)?;
        if (rows as u64 + self.scrollback as u64) * cols as u64 > 4_000_000 {
            return Err(Error::from_reason(
                "Experiment grid exceeds four million cells",
            ));
        }
        self.term
            .as_mut()
            .ok_or_else(|| Error::from_reason("Terminal disposed"))?
            .resize(size);
        Ok(())
    }

    #[napi]
    pub fn text_snapshot(&mut self, undimmed: bool) -> Result<NativeTextSnapshot> {
        let term = self
            .term
            .as_mut()
            .ok_or_else(|| Error::from_reason("Terminal disposed"))?;
        // A text read must include bytes in an unfinished synchronized update.
        // This finalizes the batch; this API does not promise ANSI replay state.
        self.parser.stop_sync(term);
        let grid = term.grid();
        let history = grid.history_size() as i32;
        let mut rows = Vec::with_capacity(grid.total_lines());
        let mut wrapped = false;
        for y in -history..grid.screen_lines() as i32 {
            let line = &grid[Line(y)];
            let mut text = String::new();
            let mut plain = String::new();
            for x in 0..grid.columns() {
                let cell = &line[Column(x)];
                if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                    continue;
                }
                text.push(cell.c);
                if let Some(chars) = cell.zerowidth() {
                    text.extend(chars);
                }
                if undimmed {
                    if cell.flags.contains(Flags::DIM) {
                        plain.push(' ');
                        if cell.flags.contains(Flags::WIDE_CHAR) {
                            plain.push(' ');
                        }
                    } else {
                        plain.push(cell.c);
                        if let Some(chars) = cell.zerowidth() {
                            plain.extend(chars);
                        }
                    }
                }
            }
            rows.push(NativeTextRow {
                // xterm trims blank grid cells, not arbitrary Unicode whitespace.
                text: text.trim_end_matches(' ').to_owned(),
                wrapped,
                undimmed: undimmed.then(|| plain.trim_end().to_owned()),
            });
            wrapped = line[Column(grid.columns() - 1)]
                .flags
                .contains(Flags::WRAPLINE);
        }
        while rows.last().is_some_and(|r| r.text.is_empty()) {
            rows.pop();
        }
        let cursor_row = history + grid.cursor.point.line.0;
        let rows_below_cursor = (rows.len() as i32 - 1 - cursor_row).max(0) as u32;
        Ok(NativeTextSnapshot {
            rows,
            rows_below_cursor,
            buffer_type: if term.mode().contains(TermMode::ALT_SCREEN) {
                "alternate"
            } else {
                "normal"
            }
            .into(),
        })
    }

    #[napi]
    pub fn ansi_snapshot(&mut self) -> Result<String> {
        let term = self
            .term
            .as_mut()
            .ok_or_else(|| Error::from_reason("Terminal disposed"))?;
        let synchronized = self.parser.sync_timeout().pending_timeout();
        self.parser.stop_sync(term);
        let mut result = crate::native_serialize::serialize(term).map_err(Error::from_reason)?;
        if synchronized {
            result.push_str("\x1b[?2026h");
        }
        Ok(result)
    }

    #[napi]
    pub fn dispose(&mut self) {
        self.term = None;
        self.parser = Processor::new();
    }
}

enum ReadEvent {
    Data(Vec<u8>),
    Eof,
    Error(String),
}

#[napi(object)]
pub struct NativePtyRead {
    pub data: Buffer,
    pub eof: bool,
    pub error: Option<String>,
}

/// Polling transport for the experiment only; no JS callbacks from reader threads.
/// The 16 x 16 KiB channel bounds queued bytes and applies OS-level backpressure.
#[napi]
pub struct NativePty {
    master: Option<Box<dyn MasterPty + Send>>,
    writer: Option<Box<dyn Write + Send>>,
    child: Option<Arc<Mutex<Box<dyn Child + Send + Sync>>>>,
    receiver: Option<Receiver<ReadEvent>>,
    eof: bool,
    pid: u32,
}

#[napi]
impl NativePty {
    #[napi(constructor)]
    pub fn new(
        command: String,
        args: Vec<String>,
        cwd: String,
        cols: u32,
        rows: u32,
    ) -> Result<Self> {
        dimensions(cols, rows)?;
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: rows as u16,
                cols: cols as u16,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let mut cmd = CommandBuilder::new(command);
        cmd.args(args);
        cmd.cwd(cwd);
        cmd.env("TERM", "xterm-256color");
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let pid = child.process_id().unwrap_or(0);
        drop(pair.slave);
        let (sender, receiver) = sync_channel(16);
        let mut result = Self {
            master: Some(pair.master),
            writer: Some(writer),
            child: Some(Arc::new(Mutex::new(child))),
            receiver: Some(receiver),
            eof: false,
            pid,
        };
        let spawned = std::thread::Builder::new()
            .name("wmux-spike-pty-read".into())
            .spawn(move || {
                let mut buffer = [0u8; 16 * 1024];
                loop {
                    let event = match reader.read(&mut buffer) {
                        Ok(0) => ReadEvent::Eof,
                        Ok(n) => ReadEvent::Data(buffer[..n].to_vec()),
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(e) => ReadEvent::Error(e.to_string()),
                    };
                    let done = !matches!(event, ReadEvent::Data(_));
                    if sender.send(event).is_err() || done {
                        break;
                    }
                }
            });
        if let Err(e) = spawned {
            result.close();
            return Err(Error::from_reason(e.to_string()));
        }
        Ok(result)
    }

    #[napi(getter)]
    pub fn pid(&self) -> u32 {
        self.pid
    }

    #[napi]
    pub fn read(&mut self) -> Result<NativePtyRead> {
        let receiver = self
            .receiver
            .as_ref()
            .ok_or_else(|| Error::from_reason("PTY closed"))?;
        let mut data = Vec::new();
        let mut error = None;
        // Bound each JS poll even if the producer continuously refills the channel.
        for _ in 0..16 {
            match receiver.try_recv() {
                Ok(ReadEvent::Data(bytes)) => data.extend(bytes),
                Ok(ReadEvent::Eof) | Err(TryRecvError::Disconnected) => {
                    self.eof = true;
                    break;
                }
                Ok(ReadEvent::Error(e)) => {
                    error = Some(e);
                    self.eof = true;
                    break;
                }
                Err(TryRecvError::Empty) => break,
            }
        }
        Ok(NativePtyRead {
            data: data.into(),
            eof: self.eof,
            error,
        })
    }

    /// Small control writes only. A production adapter must move potentially
    /// blocking writes off Node's event loop and implement node-pty's contract.
    #[napi]
    pub fn write(&mut self, bytes: Uint8Array) -> Result<()> {
        if bytes.len() > 4096 {
            return Err(Error::from_reason(
                "Experiment writes limited to 4096 bytes",
            ));
        }
        self.writer
            .as_mut()
            .ok_or_else(|| Error::from_reason("PTY closed"))?
            .write_all(&bytes)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn resize(&self, cols: u32, rows: u32) -> Result<()> {
        dimensions(cols, rows)?;
        self.master
            .as_ref()
            .ok_or_else(|| Error::from_reason("PTY closed"))?
            .resize(PtySize {
                cols: cols as u16,
                rows: rows as u16,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn try_wait(&mut self) -> Result<Option<u32>> {
        let child = self
            .child
            .as_ref()
            .ok_or_else(|| Error::from_reason("PTY closed"))?;
        // kill() can own the lock during its OS grace period; never stall Node.
        let Ok(mut child) = child.try_lock() else {
            return Ok(None);
        };
        child
            .try_wait()
            .map(|status| status.map(|s| s.exit_code()))
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn kill(&mut self) -> Result<AsyncTask<KillPty>> {
        let child = self
            .child
            .as_ref()
            .ok_or_else(|| Error::from_reason("PTY closed"))?;
        Ok(AsyncTask::new(KillPty {
            child: Arc::clone(child),
        }))
    }

    #[napi]
    pub fn close(&mut self) {
        self.receiver.take();
        self.writer.take();
        self.master.take();
        if let Some(child) = self.child.take() {
            // Both termination's grace period and reaping belong off the JS thread.
            // This owns the immediate child, not arbitrary detached descendants.
            std::thread::spawn(move || {
                if let Ok(mut child) = child.lock() {
                    if !matches!(child.try_wait(), Ok(Some(_))) {
                        let _ = child.kill();
                    }
                    let _ = child.wait();
                }
            });
        }
    }
}

impl Drop for NativePty {
    fn drop(&mut self) {
        self.close();
    }
}

pub struct KillPty {
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
}
impl Task for KillPty {
    type Output = ();
    type JsValue = ();
    fn compute(&mut self) -> Result<()> {
        let mut child = self
            .child
            .lock()
            .map_err(|_| Error::from_reason("PTY lock poisoned"))?;
        if matches!(child.try_wait(), Ok(Some(_))) {
            return Ok(());
        }
        child.kill().map_err(|e| Error::from_reason(e.to_string()))
    }
    fn resolve(&mut self, _env: Env, _output: ()) -> Result<()> {
        Ok(())
    }
}

#[derive(Clone)]
struct GeometryMark {
    at: u64,
    cols: u32,
    rows: u32,
}

#[napi(object)]
pub struct NativeGeometrySize {
    pub cols: u32,
    pub rows: u32,
}
#[napi(object)]
pub struct NativeGeometryChange {
    pub offset: f64,
    pub cols: u32,
    pub rows: u32,
}
#[napi(object)]
pub struct NativeReplayGeometry {
    pub start: NativeGeometrySize,
    pub changes: Vec<NativeGeometryChange>,
}
#[napi(object)]
pub struct NativeRingSnapshot {
    pub data: Buffer,
    pub written_at: f64,
    pub geometry: Option<NativeReplayGeometry>,
}

#[napi]
pub struct NativeFrozenRing {
    bytes: Vec<u8>,
    geometry: Vec<GeometryMark>,
    written_at: u64,
}
#[napi]
impl NativeFrozenRing {
    #[napi(getter)]
    pub fn size(&self) -> u32 {
        self.bytes.len() as u32
    }
    #[napi(getter)]
    pub fn written_at(&self) -> f64 {
        self.written_at as f64
    }
    #[napi(getter)]
    pub fn geometry(&self) -> Option<NativeReplayGeometry> {
        replay_geometry(&self.geometry, self.written_at - self.bytes.len() as u64)
    }
    #[napi]
    pub fn read_all(&self) -> Buffer {
        self.bytes.clone().into()
    }
    #[napi]
    pub fn dispose(&mut self) {
        self.bytes = Vec::new();
        self.geometry.clear();
    }
}
fn replay_geometry(marks: &[GeometryMark], start: u64) -> Option<NativeReplayGeometry> {
    marks.first().map(|first| NativeReplayGeometry {
        start: NativeGeometrySize {
            cols: first.cols,
            rows: first.rows,
        },
        changes: marks
            .iter()
            .skip(1)
            .map(|m| NativeGeometryChange {
                offset: (m.at - start) as f64,
                cols: m.cols,
                rows: m.rows,
            })
            .collect(),
    })
}

/// Byte retention and geometry use the same lifetime offset as the JS oracle.
#[napi]
pub struct NativeRing {
    bytes: Vec<u8>,
    capacity: usize,
    length: usize,
    write_pos: usize,
    total_written: u64,
    geometry: Vec<GeometryMark>,
}

#[napi]
impl NativeRing {
    #[napi(constructor)]
    pub fn new(capacity: u32) -> Result<Self> {
        if capacity == 0 || capacity > 256 * 1024 * 1024 {
            return Err(Error::from_reason("Ring capacity must be 1..256MiB"));
        }
        Ok(Self {
            bytes: vec![0; (capacity as usize).min(64 * 1024)],
            capacity: capacity as usize,
            length: 0,
            write_pos: 0,
            total_written: 0,
            geometry: Vec::new(),
        })
    }

    #[napi]
    pub fn write(&mut self, bytes: Uint8Array) -> Result<()> {
        self.write_bytes(&bytes)
    }

    #[napi]
    pub fn write_chunk(&mut self, chunk: &NativeOutputChunk) -> Result<()> {
        self.write_bytes(&chunk.bytes)
    }

    #[napi]
    pub fn read_all(&self) -> Buffer {
        self.copy_bytes().into()
    }

    #[napi]
    pub fn freeze(&mut self) -> NativeFrozenRing {
        self.prune_geometry();
        NativeFrozenRing {
            bytes: self.copy_bytes(),
            geometry: self.geometry.clone(),
            written_at: self.total_written,
        }
    }

    #[napi(getter)]
    pub fn size(&self) -> u32 {
        self.length as u32
    }
    #[napi(getter)]
    pub fn allocated_bytes(&self) -> u32 {
        self.bytes.len() as u32
    }

    #[napi(getter)]
    pub fn total_bytes_written(&self) -> f64 {
        self.total_written as f64
    }

    #[napi]
    pub fn clear(&mut self) -> Result<()> {
        if self.capacity == 0 {
            return Err(Error::from_reason("Ring disposed"));
        }
        self.bytes.fill(0);
        self.length = 0;
        self.write_pos = 0;
        Ok(())
    }

    #[napi]
    pub fn note_geometry(&mut self, cols: u32, rows: u32) -> Result<()> {
        if self.capacity == 0 {
            return Err(Error::from_reason("Ring disposed"));
        }
        if cols == 0 || rows == 0 {
            return Ok(());
        }
        if let Some(last) = self.geometry.last() {
            if last.cols == cols && last.rows == rows {
                return Ok(());
            }
            if last.at == self.total_written {
                self.geometry.pop();
            }
        }
        self.geometry.push(GeometryMark {
            at: self.total_written,
            cols,
            rows,
        });
        self.prune_geometry();
        Ok(())
    }

    #[napi(getter)]
    pub fn has_geometry_changes(&mut self) -> bool {
        self.prune_geometry();
        self.geometry.len() > 1
    }

    #[napi]
    pub fn read_all_with_geometry(&mut self) -> NativeRingSnapshot {
        self.prune_geometry();
        let start = self.total_written - self.length as u64;
        let geometry = self.geometry.first().map(|first| NativeReplayGeometry {
            start: NativeGeometrySize {
                cols: first.cols,
                rows: first.rows,
            },
            changes: self
                .geometry
                .iter()
                .skip(1)
                .map(|m| NativeGeometryChange {
                    offset: (m.at - start) as f64,
                    cols: m.cols,
                    rows: m.rows,
                })
                .collect(),
        });
        NativeRingSnapshot {
            data: self.read_all(),
            written_at: self.total_written as f64,
            geometry,
        }
    }

    #[napi]
    pub fn dispose(&mut self) {
        self.bytes = Vec::new();
        self.capacity = 0;
        self.length = 0;
        self.write_pos = 0;
        self.geometry.clear();
    }
}

impl NativeRing {
    fn write_bytes(&mut self, bytes: &[u8]) -> Result<()> {
        if self.capacity == 0 {
            return Err(Error::from_reason("Ring disposed"));
        }
        if bytes.is_empty() {
            return Ok(());
        }
        let next_total = self
            .total_written
            .checked_add(bytes.len() as u64)
            .filter(|n| *n <= 9_007_199_254_740_991)
            .ok_or_else(|| Error::from_reason("Ring byte offset exceeds JS safe integer range"))?;
        let input = if bytes.len() > self.capacity {
            &bytes[bytes.len() - self.capacity..]
        } else {
            bytes
        };
        let needed = (self.length + input.len()).min(self.capacity);
        if needed > self.bytes.len() {
            // Growth only happens before the ring has wrapped; resize preserves order.
            let mut next = self.bytes.len();
            while next < needed {
                next = (next * 2).min(self.capacity);
            }
            self.bytes
                .try_reserve_exact(next - self.bytes.len())
                .map_err(|e| Error::from_reason(e.to_string()))?;
            self.bytes.resize(next, 0);
            self.write_pos = self.length;
        }
        let tail = input.len().min(self.bytes.len() - self.write_pos);
        self.bytes[self.write_pos..self.write_pos + tail].copy_from_slice(&input[..tail]);
        self.bytes[..input.len() - tail].copy_from_slice(&input[tail..]);
        self.write_pos = (self.write_pos + input.len()) % self.bytes.len();
        self.length = needed;
        self.total_written = next_total;
        Ok(())
    }

    fn copy_bytes(&self) -> Vec<u8> {
        if self.length == 0 {
            return Vec::new();
        }
        let start = if self.length < self.bytes.len() {
            0
        } else {
            self.write_pos
        };
        let tail = self.length.min(self.bytes.len() - start);
        let mut result = Vec::with_capacity(self.length);
        result.extend_from_slice(&self.bytes[start..start + tail]);
        result.extend_from_slice(&self.bytes[..self.length - tail]);
        result
    }

    fn prune_geometry(&mut self) {
        let start = self.total_written - self.length as u64;
        let keep = self
            .geometry
            .iter()
            .rposition(|m| m.at <= start)
            .unwrap_or(0);
        if keep > 0 {
            self.geometry.drain(..keep);
        }
        if self.geometry.len() > 256 {
            self.geometry.drain(..self.geometry.len() - 256);
        }
    }
}
