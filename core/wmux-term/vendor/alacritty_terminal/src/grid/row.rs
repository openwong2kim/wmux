//! Defines the Row type which makes up lines in the grid.

use std::cmp::{max, min};
use std::ops::{Index, IndexMut, Range, RangeFrom, RangeFull, RangeTo, RangeToInclusive};
use std::{ptr, slice};

#[cfg(feature = "serde")]
use serde::{Deserialize, Serialize};

use crate::grid::GridCell;
use crate::index::Column;
use crate::term::cell::ResetDiscriminant;

/// A row in the grid.
#[derive(Default, Clone, Debug)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
// wmux: `hidden` is skipped, and serde's derive would otherwise ask `T: Default`
// for it; Row deserializes for any `T` it did before.
#[cfg_attr(feature = "serde", serde(bound(deserialize = "T: Deserialize<'de>")))]
pub struct Row<T> {
    inner: Vec<T>,

    /// Maximum number of occupied entries.
    ///
    /// This is the upper bound on the number of elements in the row, which have been modified
    /// since the last reset. All cells after this point are guaranteed to be equal.
    pub(crate) occ: usize,

    /// wmux: the cells of an alternate-screen row past a narrower width, kept
    /// as xterm.js keeps them (its line keeps its length) and shown again by a
    /// later widen. Only a resize without reflow keeps them (`hide_past`); a
    /// reset row is a new line, at the current width. Not serialized: a
    /// serialized grid keeps upstream's format (the ref tests' grids), and a
    /// deserialized row has none, as a row read back at its width would.
    #[cfg_attr(feature = "serde", serde(default, skip))]
    hidden: Option<Box<Vec<T>>>,

    /// wmux: where the empty cells a widen gave this soft-wrapped row begin
    /// (0: none). xterm leaves the cursor's paragraph unreflowed, so those
    /// cells stay empty there, unlike the blanks a program printed up to the
    /// wrap. Gone once the row is reset or its cells move.
    #[cfg_attr(feature = "serde", serde(default, skip))]
    empty_from: usize,
}

impl<T: PartialEq> PartialEq for Row<T> {
    fn eq(&self, other: &Self) -> bool {
        self.inner == other.inner
    }
}

impl<T: Default> Row<T> {
    /// Create a new terminal row.
    ///
    /// Ideally the `template` should be `Copy` in all performance sensitive scenarios.
    pub fn new(columns: usize) -> Row<T> {
        debug_assert!(columns >= 1);

        let mut inner: Vec<T> = Vec::with_capacity(columns);

        // This is a slightly optimized version of `std::vec::Vec::resize`.
        unsafe {
            let mut ptr = inner.as_mut_ptr();

            for _ in 1..columns {
                ptr::write(ptr, T::default());
                ptr = ptr.offset(1);
            }
            ptr::write(ptr, T::default());

            inner.set_len(columns);
        }

        Row { inner, occ: 0, hidden: None, empty_from: 0 }
    }

    /// Increase the number of columns in the row.
    #[inline]
    pub fn grow(&mut self, columns: usize) {
        if self.inner.len() >= columns {
            return;
        }

        // wmux: kept cells come back first, up to the new width; xterm drops
        // the rest (its line takes the new width).
        if let Some(hidden) = self.hidden.take() {
            let mut hidden = *hidden;
            hidden.truncate(columns - self.inner.len());
            self.inner.append(&mut hidden);
            self.occ = self.inner.len();
        }

        self.inner.resize_with(columns, T::default);
    }

    /// wmux: narrow to `columns` without reflow, keeping the cells past it in
    /// front of any already kept (see `hidden`).
    pub(crate) fn hide_past(&mut self, columns: usize) {
        if self.inner.len() <= columns {
            return;
        }

        let mut cut = self.inner.split_off(columns);
        if let Some(hidden) = self.hidden.take() {
            cut.extend(*hidden);
        }
        self.occ = min(self.occ, columns);
        self.hidden = Some(Box::new(cut));
    }

    /// Reduce the number of columns in the row.
    ///
    /// This will return all non-empty cells that were removed.
    pub fn shrink(&mut self, columns: usize) -> Option<Vec<T>>
    where
        T: GridCell,
    {
        if self.inner.len() <= columns {
            return None;
        }

        // Split off cells for a new row.
        let mut new_row = self.inner.split_off(columns);
        let index = new_row.iter().rposition(|c| !c.is_empty()).map_or(0, |i| i + 1);
        new_row.truncate(index);

        self.occ = min(self.occ, columns);
        if self.empty_from >= columns {
            self.empty_from = 0;
        }

        if new_row.is_empty() { None } else { Some(new_row) }
    }

    /// Reset all cells in the row to the `template` cell.
    #[inline]
    pub fn reset<D>(&mut self, template: &T)
    where
        T: ResetDiscriminant<D> + GridCell,
        D: PartialEq,
    {
        debug_assert!(!self.inner.is_empty());

        // Mark all cells as dirty if template cell changed.
        let len = self.inner.len();
        if self.inner[len - 1].discriminant() != template.discriminant() {
            self.occ = len;
        }

        // Reset every dirty cell in the row.
        for item in &mut self.inner[0..self.occ] {
            item.reset(template);
        }

        self.occ = 0;

        // wmux: a reset row is a new line, at the current width.
        self.hidden = None;
        self.empty_from = 0;
    }

    /// wmux: reset over the row's whole physical width, kept cells included,
    /// as xterm fills a whole erased line (ED); they stay kept.
    pub(crate) fn reset_keep_width<D>(&mut self, template: &T)
    where
        T: ResetDiscriminant<D> + GridCell,
        D: PartialEq,
    {
        let hidden = self.hidden.take();
        self.reset(template);
        if let Some(mut hidden) = hidden {
            for item in hidden.iter_mut() {
                item.reset(template);
            }
            self.hidden = Some(hidden);
        }
    }
}

#[allow(clippy::len_without_is_empty)]
impl<T> Row<T> {
    #[inline]
    pub fn from_vec(vec: Vec<T>, occ: usize) -> Row<T> {
        Row { inner: vec, occ, hidden: None, empty_from: 0 }
    }

    /// wmux: how many cells are kept past the visible width.
    #[inline]
    /// wmux: where the empty cells a widen gave this soft-wrapped row begin.
    pub fn empty_from(&self) -> Option<usize> {
        (self.empty_from > 0).then_some(self.empty_from)
    }

    /// wmux: mark the cells from `column` on as the empty ones a widen added.
    pub(crate) fn set_empty_from(&mut self, column: usize) {
        if column > 0 && (self.empty_from == 0 || column < self.empty_from) {
            self.empty_from = column;
        }
    }

    pub fn hidden_len(&self) -> usize {
        self.hidden.as_ref().map_or(0, |hidden| hidden.len())
    }

    /// wmux: run `f` over the row's physical cells, the visible ones then the
    /// kept ones, as xterm's line operations (ICH, DCH, ECH, insert mode) do.
    pub(crate) fn with_physical<R>(&mut self, f: impl FnOnce(&mut [T]) -> R) -> R {
        let visible = self.inner.len();
        self.occ = visible;
        self.empty_from = 0;
        match self.hidden.as_mut() {
            None => f(&mut self.inner),
            Some(hidden) => {
                // Both vectors keep their buffers: no allocation per edit.
                self.inner.append(hidden);
                let result = f(&mut self.inner);
                hidden.extend(self.inner.drain(visible..));
                result
            },
        }
    }

    /// wmux: forget the kept cells (the row's screen is no longer shown).
    pub(crate) fn drop_hidden(&mut self) {
        self.hidden = None;
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.inner.len()
    }

    #[inline]
    pub fn last(&self) -> Option<&T> {
        self.inner.last()
    }

    #[inline]
    pub fn last_mut(&mut self) -> Option<&mut T> {
        self.occ = self.inner.len();
        self.inner.last_mut()
    }

    #[inline]
    pub fn append(&mut self, vec: &mut Vec<T>)
    where
        T: GridCell,
    {
        self.occ += vec.len();
        self.empty_from = 0;
        self.inner.append(vec);
    }

    #[inline]
    pub fn append_front(&mut self, mut vec: Vec<T>) {
        self.occ += vec.len();
        self.empty_from = 0;

        vec.append(&mut self.inner);
        self.inner = vec;
    }

    /// Check if all cells in the row are empty.
    #[inline]
    pub fn is_clear(&self) -> bool
    where
        T: GridCell,
    {
        self.inner.iter().all(GridCell::is_empty)
    }

    #[inline]
    pub fn front_split_off(&mut self, at: usize) -> Vec<T> {
        self.occ = self.occ.saturating_sub(at);
        self.empty_from = 0;

        let mut split = self.inner.split_off(at);
        std::mem::swap(&mut split, &mut self.inner);
        split
    }
}

impl<'a, T> IntoIterator for &'a Row<T> {
    type IntoIter = slice::Iter<'a, T>;
    type Item = &'a T;

    #[inline]
    fn into_iter(self) -> slice::Iter<'a, T> {
        self.inner.iter()
    }
}

impl<'a, T> IntoIterator for &'a mut Row<T> {
    type IntoIter = slice::IterMut<'a, T>;
    type Item = &'a mut T;

    #[inline]
    fn into_iter(self) -> slice::IterMut<'a, T> {
        self.occ = self.len();
        self.inner.iter_mut()
    }
}

impl<T> Index<Column> for Row<T> {
    type Output = T;

    #[inline]
    fn index(&self, index: Column) -> &T {
        &self.inner[index.0]
    }
}

impl<T> IndexMut<Column> for Row<T> {
    #[inline]
    fn index_mut(&mut self, index: Column) -> &mut T {
        self.occ = max(self.occ, *index + 1);
        &mut self.inner[index.0]
    }
}

impl<T> Index<Range<Column>> for Row<T> {
    type Output = [T];

    #[inline]
    fn index(&self, index: Range<Column>) -> &[T] {
        &self.inner[(index.start.0)..(index.end.0)]
    }
}

impl<T> IndexMut<Range<Column>> for Row<T> {
    #[inline]
    fn index_mut(&mut self, index: Range<Column>) -> &mut [T] {
        self.occ = max(self.occ, *index.end);
        &mut self.inner[(index.start.0)..(index.end.0)]
    }
}

impl<T> Index<RangeTo<Column>> for Row<T> {
    type Output = [T];

    #[inline]
    fn index(&self, index: RangeTo<Column>) -> &[T] {
        &self.inner[..(index.end.0)]
    }
}

impl<T> IndexMut<RangeTo<Column>> for Row<T> {
    #[inline]
    fn index_mut(&mut self, index: RangeTo<Column>) -> &mut [T] {
        self.occ = max(self.occ, *index.end);
        &mut self.inner[..(index.end.0)]
    }
}

impl<T> Index<RangeFrom<Column>> for Row<T> {
    type Output = [T];

    #[inline]
    fn index(&self, index: RangeFrom<Column>) -> &[T] {
        &self.inner[(index.start.0)..]
    }
}

impl<T> IndexMut<RangeFrom<Column>> for Row<T> {
    #[inline]
    fn index_mut(&mut self, index: RangeFrom<Column>) -> &mut [T] {
        self.occ = self.len();
        &mut self.inner[(index.start.0)..]
    }
}

impl<T> Index<RangeFull> for Row<T> {
    type Output = [T];

    #[inline]
    fn index(&self, _: RangeFull) -> &[T] {
        &self.inner[..]
    }
}

impl<T> IndexMut<RangeFull> for Row<T> {
    #[inline]
    fn index_mut(&mut self, _: RangeFull) -> &mut [T] {
        self.occ = self.len();
        &mut self.inner[..]
    }
}

impl<T> Index<RangeToInclusive<Column>> for Row<T> {
    type Output = [T];

    #[inline]
    fn index(&self, index: RangeToInclusive<Column>) -> &[T] {
        &self.inner[..=(index.end.0)]
    }
}

impl<T> IndexMut<RangeToInclusive<Column>> for Row<T> {
    #[inline]
    fn index_mut(&mut self, index: RangeToInclusive<Column>) -> &mut [T] {
        self.occ = max(self.occ, *index.end + 1);
        &mut self.inner[..=(index.end.0)]
    }
}
