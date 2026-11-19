//! wmux: fallible allocation for the grid and the terminal state sized by it
//! (#3440).
//!
//! Every allocation sized by the grid's columns, lines or scrollback reserves
//! with `try_reserve`. A refusal cannot travel back as a `Result`: the grid is
//! driven from vte's `Perform` callbacks, which return nothing. It unwinds
//! instead, with the zero-sized payload [`GridAllocFailed`]:
//!
//! - `resume_unwind` runs no panic hook, so nothing is formatted and no
//!   backtrace is captured, whatever `RUST_BACKTRACE` says;
//! - a boxed zero-sized value allocates nothing, so the unwind itself asks
//!   the allocator for nothing (on the MSVC targets; the Itanium unwinder on
//!   other targets allocates its exception header);
//! - what was refused travels in a thread-local `Cell` with no destructor
//!   ([`take_refusal`]).
//!
//! The caller catches the unwind around its whole call into the terminal,
//! downcasts the payload, and treats the terminal as unusable from then on:
//! the refusal may have left the grid half updated (its memory stays safe to
//! drop). Nothing in the grid holds a lock across these calls.

use std::cell::Cell;
use std::panic;

/// A row's cells: at most the grid's columns.
pub const ROW: &str = "a grid row";
/// The grid's rows: the screen's lines, and the history up to its cap.
pub const LINES: &str = "the grid's lines";
/// The rows a resize lays out again: at most the grid's rows, plus the rows a
/// narrowing's reflow adds.
pub const REFLOW: &str = "a grid reflow";
/// The tab stops: one per column.
pub const TABS: &str = "the terminal's tab stops";
/// The damage record: one per screen line.
pub const DAMAGE: &str = "the terminal's line damage";

/// The payload of the unwind a refused grid allocation raises. Zero-sized:
/// boxing it allocates nothing. What was refused is in [`take_refusal`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GridAllocFailed;

thread_local! {
    /// The last refusal on this thread: the bytes asked for, and what for.
    static REFUSED: Cell<(usize, &'static str)> = const { Cell::new((0, "")) };
    /// Test injection: every allocation made for this purpose is refused.
    static FAIL_WHAT: Cell<Option<&'static str>> = const { Cell::new(None) };
}

/// The bytes and the purpose of the refusal behind the last
/// [`GridAllocFailed`] unwind on this thread.
pub fn take_refusal() -> (usize, &'static str) {
    REFUSED.with(|refused| refused.replace((0, "")))
}

/// Test hook (wmux-term's tests use it too, so it is not `cfg(test)`): until
/// the guard drops, every allocation this module makes for `what` on this
/// thread is refused as if the allocator had refused it.
#[doc(hidden)]
pub fn fail_what(what: &'static str) -> FailGuard {
    FailGuard(FAIL_WHAT.with(|fail| fail.replace(Some(what))))
}

/// Restores the previous injection when dropped.
#[doc(hidden)]
pub struct FailGuard(Option<&'static str>);

impl Drop for FailGuard {
    fn drop(&mut self) {
        FAIL_WHAT.with(|fail| fail.set(self.0));
    }
}

#[cold]
#[inline(never)]
fn refuse(bytes: usize, what: &'static str) -> ! {
    REFUSED.with(|refused| refused.set((bytes, what)));
    panic::resume_unwind(Box::new(GridAllocFailed))
}

/// Room for `additional` more elements in `vec`, or the unwind. Once it
/// returns, pushing that many elements does not allocate.
#[inline]
pub(crate) fn reserve<T>(vec: &mut Vec<T>, additional: usize, what: &'static str) {
    if vec.capacity() - vec.len() >= additional {
        return;
    }
    reserve_slow(vec, additional, what);
}

#[cold]
#[inline(never)]
fn reserve_slow<T>(vec: &mut Vec<T>, additional: usize, what: &'static str) {
    let injected = FAIL_WHAT.with(|fail| fail.get() == Some(what));
    if injected || vec.try_reserve(additional).is_err() {
        let count = vec.len().saturating_add(additional);
        refuse(count.saturating_mul(size_of::<T>()), what);
    }
}

/// An empty vector with room for `count` elements.
#[inline]
pub(crate) fn with_capacity<T>(count: usize, what: &'static str) -> Vec<T> {
    let mut vec = Vec::new();
    reserve(&mut vec, count, what);
    vec
}

/// `vec.push(value)`.
#[inline]
pub(crate) fn push<T>(vec: &mut Vec<T>, value: T, what: &'static str) {
    reserve(vec, 1, what);
    vec.push(value);
}

/// `vec.split_off(at)`: `vec` keeps its buffer, the tail gets a new one.
#[inline]
pub(crate) fn split_off<T>(vec: &mut Vec<T>, at: usize, what: &'static str) -> Vec<T> {
    let mut tail = with_capacity(vec.len() - at, what);
    tail.extend(vec.drain(at..));
    tail
}

/// `vec.resize_with(len, fill)`.
#[inline]
pub(crate) fn resize_with<T>(
    vec: &mut Vec<T>,
    len: usize,
    fill: impl FnMut() -> T,
    what: &'static str,
) {
    reserve(vec, len.saturating_sub(vec.len()), what);
    vec.resize_with(len, fill);
}

/// `vec.append(other)`.
#[inline]
pub(crate) fn append<T>(vec: &mut Vec<T>, other: &mut Vec<T>, what: &'static str) {
    reserve(vec, other.len(), what);
    vec.append(other);
}

/// `iter.collect()` for an iterator of known length.
#[inline]
pub(crate) fn collect<T>(iter: impl ExactSizeIterator<Item = T>, what: &'static str) -> Vec<T> {
    let mut vec = with_capacity(iter.len(), what);
    vec.extend(iter);
    vec
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::panic::{AssertUnwindSafe, catch_unwind};

    /// Runs `f`, which must unwind with a refusal, and returns that refusal.
    pub(crate) fn refusal_of(f: impl FnOnce()) -> (usize, &'static str) {
        let payload = catch_unwind(AssertUnwindSafe(f)).expect_err("the allocation is refused");
        assert!(
            payload.is::<GridAllocFailed>(),
            "the payload is GridAllocFailed"
        );
        take_refusal()
    }

    #[test]
    fn a_refusal_unwinds_with_its_bytes_and_purpose() {
        let _fail = fail_what(ROW);
        let refused = refusal_of(|| drop(with_capacity::<u64>(205, ROW)));
        assert_eq!(refused, (205 * 8, ROW));
        assert_eq!(take_refusal(), (0, ""), "taken once");
    }

    #[test]
    fn injection_refuses_only_its_purpose_and_only_a_real_allocation() {
        let _fail = fail_what(ROW);
        let mut lines: Vec<u8> = with_capacity(4, LINES);
        // Room already there: nothing is allocated, nothing is refused.
        let mut row: Vec<u8> = Vec::with_capacity(4);
        reserve(&mut row, 4, ROW);
        push(&mut lines, 1, LINES);
        row.extend([0; 4]);
        // Full: the next push allocates, and is refused.
        assert_eq!(refusal_of(|| push(&mut row, 1, ROW)).1, ROW);
    }

    #[test]
    fn the_helpers_match_std() {
        let mut v = vec![1, 2, 3, 4];
        assert_eq!(split_off(&mut v, 1, ROW), [2, 3, 4]);
        assert_eq!(v, [1]);
        resize_with(&mut v, 3, || 9, ROW);
        assert_eq!(v, [1, 9, 9]);
        append(&mut v, &mut vec![5], ROW);
        assert_eq!(v, [1, 9, 9, 5]);
        assert_eq!(collect((0..3).map(|i| i * 2), ROW), [0, 2, 4]);
        assert_eq!(take_refusal(), (0, ""));
    }

    #[test]
    fn a_size_past_the_address_space_is_refused_not_aborted() {
        let mut v: Vec<u64> = Vec::new();
        let (bytes, what) = refusal_of(|| reserve(&mut v, usize::MAX / 4, LINES));
        assert_eq!((bytes, what), (usize::MAX, LINES));
    }

    mod grid {
        use super::refusal_of;
        use crate::event::VoidListener;
        use crate::grid::Grid;
        use crate::index::Line;
        use crate::term::cell::Cell;
        use crate::term::test::TermSize;
        use crate::term::{Config, Term};
        use crate::wmux_alloc::{DAMAGE, LINES, REFLOW, ROW, TABS, fail_what};

        const CELL: usize = size_of::<Cell>();

        #[test]
        fn a_refused_row_unwinds() {
            let mut grid: Grid<Cell> = Grid::new(3, 10, 0);
            let _fail = fail_what(ROW);
            // Widening without reflow grows each row in place.
            assert_eq!(refusal_of(|| grid.resize(false, 3, 205)), (205 * CELL, ROW));
        }

        #[test]
        fn a_refused_history_growth_unwinds() {
            let mut grid: Grid<Cell> = Grid::new(3, 10, 100);
            let _fail = fail_what(LINES);
            let (_, what) = refusal_of(|| grid.scroll_up(&(Line(0)..Line(3)), 1));
            assert_eq!(what, LINES);
        }

        #[test]
        fn a_refused_reflow_unwinds() {
            let mut grid: Grid<Cell> = Grid::new(3, 10, 100);
            let _fail = fail_what(REFLOW);
            assert_eq!(refusal_of(|| grid.resize(true, 3, 5)).1, REFLOW);
        }

        #[test]
        fn a_refused_term_unwinds_from_new() {
            for what in [LINES, ROW, TABS, DAMAGE] {
                let _fail = fail_what(what);
                let refused = refusal_of(|| {
                    drop(Term::new(
                        Config::default(),
                        &TermSize::new(205, 24),
                        VoidListener,
                    ));
                });
                assert_eq!(refused.1, what);
            }
        }
    }

    /// The unwind of a refusal, under an allocator that refuses everything:
    /// it must ask for nothing (it would abort otherwise). The Itanium
    /// unwinder (non-MSVC targets) allocates its exception header, so this
    /// holds on the MSVC targets only.
    #[cfg(all(windows, target_env = "msvc"))]
    mod refusing_allocator {
        use std::alloc::{GlobalAlloc, Layout, System};
        use std::cell::Cell;
        use std::panic::{AssertUnwindSafe, catch_unwind};

        use crate::grid::Grid;
        use crate::term::cell::Cell as GridCell;
        use crate::wmux_alloc::{GridAllocFailed, REFLOW, take_refusal};

        thread_local! {
            /// While set, every allocation on this thread is refused.
            static ARMED: Cell<bool> = const { Cell::new(false) };
            /// Allocations asked for while armed.
            static ASKED: Cell<usize> = const { Cell::new(0) };
        }

        struct Refusing;

        // SAFETY: forwards to `System`, or refuses with a null pointer.
        unsafe impl GlobalAlloc for Refusing {
            unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
                if ARMED.try_with(Cell::get).unwrap_or(false) {
                    ASKED.with(|asked| asked.set(asked.get() + 1));
                    return std::ptr::null_mut();
                }
                unsafe { System.alloc(layout) }
            }

            unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
                unsafe { System.dealloc(ptr, layout) }
            }
        }

        #[global_allocator]
        static GLOBAL: Refusing = Refusing;

        #[test]
        fn a_real_refusal_unwinds_without_allocating() {
            let mut grid: Grid<GridCell> = Grid::new(24, 80, 100);
            ARMED.with(|armed| armed.set(true));
            let caught = catch_unwind(AssertUnwindSafe(|| grid.resize(true, 24, 205)));
            let is_refusal = caught
                .as_ref()
                .is_err_and(|payload| payload.is::<GridAllocFailed>());
            let refused = take_refusal();
            drop(caught);
            ARMED.with(|armed| armed.set(false));
            assert!(is_refusal, "the resize unwinds with GridAllocFailed");
            assert_eq!(refused.1, REFLOW);
            assert_eq!(
                ASKED.with(Cell::get),
                1,
                "only the refused reservation asked"
            );
        }
    }
}
