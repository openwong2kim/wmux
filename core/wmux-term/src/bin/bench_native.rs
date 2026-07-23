//! V4a — vte-only native feed throughput microbench.
//!
//! Gate ≥250MB/s (50% of budget 500). Synthetic ANSI stream ≥64MB,
//! measure after warmup. Print result as MB/s to stdout.
//!
//! Run: cargo run --release --bin bench_native

use std::time::Instant;
use wmux_term::Grid;

/// Build a representative workload-approximate synthetic ANSI stream.
///
/// Block composition: SGR color switches + ASCII text + **CSI cursor moves (parameter parsing path)** +
/// **UTF-8 multibyte (Korean — continuation-byte path)** + CRLF.
/// **Note (honest label — review feedback)**: this figure is a best-case upper bound — OSC/DCS,
/// chunk-boundary split escapes, and emoji ZWJ worst paths are excluded (remeasure after E1 cell attrs).
fn synth_stream(target_bytes: usize) -> Vec<u8> {
    let mut buf = Vec::with_capacity(target_bytes + 512);
    let block: &[u8] =
        "\x1b[31mERROR\x1b[0m build failed at \x1b[1msrc/main.rs:42\x1b[0m: \
          expected `;` \x1b[2mnote: consider adding\x1b[0m\r\n\
          \x1b[32m  Compiling\x1b[0m wmux-term v0.0.0 (units 1/1)\r\n\
          \x1b[10;5H\x1b[2K빌드 진행 중… 한글 로그 라인 \x1b[0;36m확인\x1b[0m\r\n"
            .as_bytes();
    while buf.len() < target_bytes {
        buf.extend_from_slice(block);
    }
    buf.truncate(target_bytes);
    buf
}

fn main() {
    let total_bytes: usize = 64 * 1024 * 1024; // 64MB
    let stream = synth_stream(total_bytes);
    let chunk = 16 * 1024; // 16KB chunks for feed (PTY read approximation).

    // Warmup — stream 3MB to stabilize cache and branch prediction.
    // (Review feedback: `.min` must apply to the whole product — operator-precedence bug fix.)
    {
        let mut g = Grid::new(80, 24);
        let warm_len = (3 * 1024 * 1024usize).min(stream.len());
        for c in stream[..warm_len].chunks(chunk) {
            std::hint::black_box(g.feed(c));
        }
    }

    // Measurement — feed full stream into a fresh grid.
    let mut g = Grid::new(80, 24);
    let t0 = Instant::now();
    let mut acc_dirty: u64 = 0;
    for c in stream.chunks(chunk) {
        let r = g.feed(c);
        acc_dirty = acc_dirty.wrapping_add(r.dirty_rows as u64);
    }
    let elapsed = t0.elapsed();
    std::hint::black_box(acc_dirty);
    // Observe final grid contents so the cell write path cannot be LTO-stripped (review feedback).
    let mut sink: u64 = 0;
    for y in 0..g.rows() {
        for ch in g.snapshot_row(y).chars() {
            sink = sink.wrapping_add(ch as u64);
        }
    }
    std::hint::black_box(sink);

    let mb = total_bytes as f64 / (1024.0 * 1024.0);
    let secs = elapsed.as_secs_f64();
    let mbps = mb / secs;

    println!("[V4a] native vte-only feed throughput");
    println!("  bytes    = {} MB", mb as u64);
    println!("  elapsed  = {:.4} s", secs);
    println!("  throughput = {:.1} MB/s", mbps);
    println!("  gate     = 250 MB/s (50% of 500 budget)");
    if mbps >= 250.0 {
        println!("  RESULT   = PASS");
        std::process::exit(0);
    } else {
        println!("  RESULT   = BELOW GATE (design review trigger data)");
        std::process::exit(2); // Below gate — non-zero exit for honest reporting.
    }
}
