//! The test binary's allocator: `System`, which can be told to refuse or to
//! count large allocations on one thread. Every test build has it, so a test
//! can show that a buffer the system sizes is reserved fallibly: an
//! infallible one refused here aborts the test binary.
#![cfg_attr(not(feature = "native-core"), allow(dead_code))]

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

thread_local! {
    static REFUSE_FROM: Cell<usize> = const { Cell::new(usize::MAX) };
    static REFUSED: Cell<usize> = const { Cell::new(0) };
    static COUNT_FROM: Cell<usize> = const { Cell::new(usize::MAX) };
    static COUNTED: Cell<usize> = const { Cell::new(0) };
}

struct Watching;

// SAFETY: forwards to `System`, or refuses with a null pointer.
unsafe impl GlobalAlloc for Watching {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let size = layout.size();
        if size >= REFUSE_FROM.try_with(Cell::get).unwrap_or(usize::MAX) {
            let _ = REFUSED.try_with(|refused| refused.set(refused.get() + 1));
            return std::ptr::null_mut();
        }
        if size >= COUNT_FROM.try_with(Cell::get).unwrap_or(usize::MAX) {
            let _ = COUNTED.try_with(|counted| counted.set(counted.get() + 1));
        }
        System.alloc(layout)
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout)
    }
}

#[global_allocator]
static GLOBAL: Watching = Watching;

/// `f`, with every allocation of at least `from` bytes on this thread
/// refused.
pub(crate) fn refusing<R>(from: usize, f: impl FnOnce() -> R) -> R {
    REFUSED.with(|refused| refused.set(0));
    REFUSE_FROM.with(|limit| limit.set(from));
    let result = f();
    REFUSE_FROM.with(|limit| limit.set(usize::MAX));
    result
}

/// How many allocations the last `refusing` refused.
pub(crate) fn refused() -> usize {
    REFUSED.with(Cell::get)
}

/// `f`, and how many allocations of at least `from` bytes it made on
/// this thread.
pub(crate) fn counting<R>(from: usize, f: impl FnOnce() -> R) -> (R, usize) {
    COUNTED.with(|counted| counted.set(0));
    COUNT_FROM.with(|limit| limit.set(from));
    let result = f();
    COUNT_FROM.with(|limit| limit.set(usize::MAX));
    (result, COUNTED.with(Cell::get))
}
