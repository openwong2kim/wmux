//! The output ring's compressed storage (`session.ringCompression`).
//!
//! The retained bytes are closed chunks of `chunk` raw bytes each, oldest
//! first, compressed with zstd level 1, then an open raw tail shorter than
//! one chunk: the live output a pane is still drawing is never compressed.
//! Retention and eviction count raw bytes, exactly like the plain ring, so
//! replay depth and every lifetime offset are unchanged: the first `skip`
//! raw bytes of the oldest chunk are already outside the window.
//!
//! Every reader gets the raw bytes back (`copy`), so the formats outside this
//! module (frozen copies, `.buf` dumps) do not change. A write is staged
//! before anything moves: a refused allocation leaves the ring as it was.

use std::cell::RefCell;
use std::collections::VecDeque;

use crate::fallible::{self, AllocFailed};

/// Raw bytes in one closed chunk: terminal output compresses about tenfold
/// at this size, and one chunk compresses in well under a millisecond.
pub(crate) const CHUNK_BYTES: usize = 256 * 1024;
/// The tail's first allocation; it grows by doubling up to one chunk.
const INITIAL_TAIL: usize = 64 * 1024;
/// zstd's fastest regular level.
const LEVEL: i32 = 1;

pub(crate) const PACKED_CHUNK: &str = "a compressed output ring chunk";
const CHUNK_LIST: &str = "the compressed output ring's chunk list";
const TAIL: &str = "the compressed output ring's open tail";
const SCRATCH: &str = "the output ring's compression buffer";
const CODEC: &str = "the output ring's zstd context";
const UNPACKED: &str = "a decompressed output ring chunk";
const JOINED: &str = "the output ring's chunk join buffer";

enum Chunk {
    Zstd(Vec<u8>),
    /// Output zstd could not shrink, kept as it was.
    Raw(Vec<u8>),
}

impl Chunk {
    fn stored(&self) -> &[u8] {
        match self {
            Chunk::Zstd(b) | Chunk::Raw(b) => b,
        }
    }
    fn wipe(&mut self) {
        match self {
            Chunk::Zstd(b) | Chunk::Raw(b) => b.fill(0),
        }
    }
}

/// One compression and one decompression context for every ring on the
/// thread (the daemon's rings are all written from its JS thread), the
/// buffer a chunk compresses into before its exact-size copy, and the one a
/// tail is joined with the start of a write in (so a refused write leaves the
/// tail's own buffer as it was).
struct Codec {
    cctx: Option<zstd_safe::CCtx<'static>>,
    dctx: Option<zstd_safe::DCtx<'static>>,
    scratch: Vec<u8>,
    joined: Vec<u8>,
}

thread_local! {
    static CODEC_STATE: RefCell<Codec> = const {
        RefCell::new(Codec { cctx: None, dctx: None, scratch: Vec::new(), joined: Vec::new() })
    };
}

/// zstd allocates its contexts with the C allocator, which reports a refusal
/// as a null context or an error code, never an abort.
fn codec_refused(bytes: usize) -> AllocFailed {
    AllocFailed { what: CODEC, bytes }
}

/// One closed chunk: `head` (a tail, possibly empty) then `rest`.
fn pack(head: &[u8], rest: &[u8]) -> Result<Chunk, AllocFailed> {
    CODEC_STATE.with(|state| {
        let mut state = state.borrow_mut();
        let Codec {
            cctx,
            scratch,
            joined,
            ..
        } = &mut *state;
        let raw = if head.is_empty() {
            rest
        } else {
            joined.clear();
            fallible::try_reserve_exact(joined, head.len() + rest.len(), JOINED)?;
            joined.extend_from_slice(head);
            joined.extend_from_slice(rest);
            &joined[..]
        };
        if cctx.is_none() {
            *cctx = Some(zstd_safe::CCtx::try_create().ok_or(codec_refused(raw.len()))?);
        }
        let bound = zstd_safe::compress_bound(raw.len());
        if scratch.len() < bound {
            fallible::try_reserve_exact(scratch, bound - scratch.len(), SCRATCH)?;
            scratch.resize(bound, 0);
        }
        let cctx = cctx.as_mut().expect("created above");
        let packed = cctx
            .compress(&mut scratch[..bound], raw, LEVEL)
            .map_err(|_| codec_refused(raw.len()))?;
        Ok(if packed < raw.len() {
            Chunk::Zstd(fallible::try_copy(&scratch[..packed], PACKED_CHUNK)?)
        } else {
            Chunk::Raw(fallible::try_copy(raw, PACKED_CHUNK)?)
        })
    })
}

/// `chunk` back into `out`, which is exactly its raw length.
fn unpack(chunk: &Chunk, out: &mut [u8]) -> Result<(), AllocFailed> {
    match chunk {
        Chunk::Raw(b) => {
            out.copy_from_slice(b);
            Ok(())
        }
        Chunk::Zstd(b) => CODEC_STATE.with(|state| {
            let mut state = state.borrow_mut();
            if state.dctx.is_none() {
                state.dctx = Some(zstd_safe::DCtx::try_create().ok_or(codec_refused(out.len()))?);
            }
            let dctx = state.dctx.as_mut().expect("created above");
            // The chunk is this module's own output: the only failure left is
            // zstd's workspace allocation.
            match dctx.decompress(out, b) {
                Ok(n) if n == out.len() => Ok(()),
                _ => Err(codec_refused(out.len())),
            }
        }),
    }
}

pub(crate) struct PackedRing {
    /// Raw bytes per closed chunk: CHUNK_BYTES, or the capacity when smaller.
    chunk: usize,
    capacity: usize,
    chunks: VecDeque<Chunk>,
    /// Raw bytes at the start of the oldest chunk that are outside the window.
    skip: usize,
    tail: Vec<u8>,
    /// Stored bytes held in `chunks`.
    packed_bytes: usize,
}

impl PackedRing {
    pub(crate) fn create(capacity: usize) -> Result<Self, AllocFailed> {
        let chunk = CHUNK_BYTES.min(capacity);
        Ok(Self {
            chunk,
            capacity,
            chunks: VecDeque::new(),
            skip: 0,
            tail: fallible::try_with_capacity(INITIAL_TAIL.min(chunk), TAIL)?,
            packed_bytes: 0,
        })
    }

    /// Raw bytes retained.
    pub(crate) fn len(&self) -> usize {
        self.chunks.len() * self.chunk - self.skip + self.tail.len()
    }

    /// Bytes this storage holds allocated: the compressed chunks and the tail.
    pub(crate) fn allocated(&self) -> usize {
        self.packed_bytes + self.tail.capacity()
    }

    /// Appends `input` (at most the capacity), then drops the oldest raw
    /// bytes past the capacity. On a refusal nothing has changed.
    pub(crate) fn write(&mut self, input: &[u8]) -> Result<(), AllocFailed> {
        debug_assert!(input.len() <= self.capacity);
        let c = self.chunk;
        let held = self.tail.len();
        let total = held + input.len();
        let closes = total / c;
        // Stage every chunk this write closes.
        fallible::try_reserve_deque(&mut self.chunks, closes, CHUNK_LIST)?;
        let mut staged: Vec<Chunk> = fallible::try_with_capacity(closes, CHUNK_LIST)?;
        let mut used = 0;
        if closes > 0 {
            used = c - held;
            // The tail, then the start of this write.
            staged.push(pack(&self.tail, &input[..used])?);
            for _ in 1..closes {
                staged.push(pack(&[], &input[used..used + c])?);
                used += c;
            }
        }
        // Room for the tail this write leaves, by doubling up to one chunk.
        let rest = input.len() - used;
        let tail_len = if closes > 0 { rest } else { total };
        if tail_len > self.tail.capacity() {
            let mut next = self.tail.capacity().max(1);
            while next < tail_len {
                next = next.saturating_mul(2);
            }
            // The tail holds `held` bytes here; its capacity exceeds that.
            fallible::try_reserve_exact(&mut self.tail, next.min(c) - held, TAIL)?;
        }
        // Commit: nothing below allocates.
        if closes > 0 {
            self.tail.fill(0);
            self.tail.clear();
        }
        self.tail.extend_from_slice(&input[used..]);
        for chunk in staged {
            self.packed_bytes += chunk.stored().len();
            self.chunks.push_back(chunk);
        }
        self.evict();
        Ok(())
    }

    /// The tail is under one chunk and never more than the capacity, so the
    /// excess always lies inside the closed chunks.
    fn evict(&mut self) {
        let Some(mut excess) = self.len().checked_sub(self.capacity) else {
            return;
        };
        while excess > 0 && excess >= self.chunk - self.skip {
            excess -= self.chunk - self.skip;
            if let Some(mut oldest) = self.chunks.pop_front() {
                self.packed_bytes -= oldest.stored().len();
                oldest.wipe();
            }
            self.skip = 0;
        }
        self.skip += excess;
    }

    /// The retained raw bytes, oldest first (at most the capacity).
    pub(crate) fn copy(&self, what: &'static str) -> Result<Vec<u8>, AllocFailed> {
        let len = self.len();
        let mut out = fallible::try_zeroed(len, what)?;
        let mut at = 0;
        for (i, chunk) in self.chunks.iter().enumerate() {
            if i == 0 && self.skip > 0 {
                let mut first = fallible::try_zeroed(self.chunk, UNPACKED)?;
                unpack(chunk, &mut first)?;
                let kept = self.chunk - self.skip;
                out[..kept].copy_from_slice(&first[self.skip..]);
                first.fill(0);
                at = kept;
                continue;
            }
            unpack(chunk, &mut out[at..at + self.chunk])?;
            at += self.chunk;
        }
        out[at..].copy_from_slice(&self.tail);
        Ok(out)
    }

    /// Drops every byte, zeroing what was stored; keeps the tail's buffer.
    pub(crate) fn clear(&mut self) {
        for chunk in &mut self.chunks {
            chunk.wipe();
        }
        self.chunks.clear();
        self.skip = 0;
        self.packed_bytes = 0;
        self.tail.fill(0);
        self.tail.clear();
    }
}
