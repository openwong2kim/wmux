//! Tests for the Grid.

use super::*;

use crate::term::cell::Cell;

impl GridCell for usize {
    fn is_empty(&self) -> bool {
        *self == 0
    }

    fn reset(&mut self, template: &Self) {
        *self = *template;
    }

    fn flags(&self) -> &Flags {
        unimplemented!();
    }

    fn flags_mut(&mut self) -> &mut Flags {
        unimplemented!();
    }
}

// Scroll up moves lines upward.
#[test]
fn scroll_up() {
    let mut grid = Grid::<usize>::new(10, 1, 0);
    for i in 0..10 {
        grid[Line(i as i32)][Column(0)] = i;
    }

    grid.scroll_up::<usize>(&(Line(0)..Line(10)), 2);

    assert_eq!(grid[Line(0)][Column(0)], 2);
    assert_eq!(grid[Line(0)].occ, 1);
    assert_eq!(grid[Line(1)][Column(0)], 3);
    assert_eq!(grid[Line(1)].occ, 1);
    assert_eq!(grid[Line(2)][Column(0)], 4);
    assert_eq!(grid[Line(2)].occ, 1);
    assert_eq!(grid[Line(3)][Column(0)], 5);
    assert_eq!(grid[Line(3)].occ, 1);
    assert_eq!(grid[Line(4)][Column(0)], 6);
    assert_eq!(grid[Line(4)].occ, 1);
    assert_eq!(grid[Line(5)][Column(0)], 7);
    assert_eq!(grid[Line(5)].occ, 1);
    assert_eq!(grid[Line(6)][Column(0)], 8);
    assert_eq!(grid[Line(6)].occ, 1);
    assert_eq!(grid[Line(7)][Column(0)], 9);
    assert_eq!(grid[Line(7)].occ, 1);
    assert_eq!(grid[Line(8)][Column(0)], 0); // was 0.
    assert_eq!(grid[Line(8)].occ, 0);
    assert_eq!(grid[Line(9)][Column(0)], 0); // was 1.
    assert_eq!(grid[Line(9)].occ, 0);
}

// Scroll down moves lines downward.
#[test]
fn scroll_down() {
    let mut grid = Grid::<usize>::new(10, 1, 0);
    for i in 0..10 {
        grid[Line(i as i32)][Column(0)] = i;
    }

    grid.scroll_down::<usize>(&(Line(0)..Line(10)), 2);

    assert_eq!(grid[Line(0)][Column(0)], 0); // was 8.
    assert_eq!(grid[Line(0)].occ, 0);
    assert_eq!(grid[Line(1)][Column(0)], 0); // was 9.
    assert_eq!(grid[Line(1)].occ, 0);
    assert_eq!(grid[Line(2)][Column(0)], 0);
    assert_eq!(grid[Line(2)].occ, 1);
    assert_eq!(grid[Line(3)][Column(0)], 1);
    assert_eq!(grid[Line(3)].occ, 1);
    assert_eq!(grid[Line(4)][Column(0)], 2);
    assert_eq!(grid[Line(4)].occ, 1);
    assert_eq!(grid[Line(5)][Column(0)], 3);
    assert_eq!(grid[Line(5)].occ, 1);
    assert_eq!(grid[Line(6)][Column(0)], 4);
    assert_eq!(grid[Line(6)].occ, 1);
    assert_eq!(grid[Line(7)][Column(0)], 5);
    assert_eq!(grid[Line(7)].occ, 1);
    assert_eq!(grid[Line(8)][Column(0)], 6);
    assert_eq!(grid[Line(8)].occ, 1);
    assert_eq!(grid[Line(9)][Column(0)], 7);
    assert_eq!(grid[Line(9)].occ, 1);
}

#[test]
fn scroll_down_with_history() {
    let mut grid = Grid::<usize>::new(10, 1, 1);
    grid.increase_scroll_limit(1);
    for i in 0..10 {
        grid[Line(i as i32)][Column(0)] = i;
    }

    grid.scroll_down::<usize>(&(Line(0)..Line(10)), 2);

    assert_eq!(grid[Line(0)][Column(0)], 0); // was 8.
    assert_eq!(grid[Line(0)].occ, 0);
    assert_eq!(grid[Line(1)][Column(0)], 0); // was 9.
    assert_eq!(grid[Line(1)].occ, 0);
    assert_eq!(grid[Line(2)][Column(0)], 0);
    assert_eq!(grid[Line(2)].occ, 1);
    assert_eq!(grid[Line(3)][Column(0)], 1);
    assert_eq!(grid[Line(3)].occ, 1);
    assert_eq!(grid[Line(4)][Column(0)], 2);
    assert_eq!(grid[Line(4)].occ, 1);
    assert_eq!(grid[Line(5)][Column(0)], 3);
    assert_eq!(grid[Line(5)].occ, 1);
    assert_eq!(grid[Line(6)][Column(0)], 4);
    assert_eq!(grid[Line(6)].occ, 1);
    assert_eq!(grid[Line(7)][Column(0)], 5);
    assert_eq!(grid[Line(7)].occ, 1);
    assert_eq!(grid[Line(8)][Column(0)], 6);
    assert_eq!(grid[Line(8)].occ, 1);
    assert_eq!(grid[Line(9)][Column(0)], 7);
    assert_eq!(grid[Line(9)].occ, 1);
}

// Test that GridIterator works.
#[test]
fn test_iter() {
    let assert_indexed = |value: usize, indexed: Option<Indexed<&usize>>| {
        assert_eq!(Some(&value), indexed.map(|indexed| indexed.cell));
    };

    let mut grid = Grid::<usize>::new(5, 5, 0);
    for i in 0..5 {
        for j in 0..5 {
            grid[Line(i)][Column(j)] = i as usize * 5 + j;
        }
    }

    let mut iter = grid.iter_from(Point::new(Line(0), Column(0)));

    assert_eq!(None, iter.prev());
    assert_indexed(1, iter.next());
    assert_eq!(Column(1), iter.point().column);
    assert_eq!(0, iter.point().line);

    assert_indexed(2, iter.next());
    assert_indexed(3, iter.next());
    assert_indexed(4, iter.next());

    // Test line-wrapping.
    assert_indexed(5, iter.next());
    assert_eq!(Column(0), iter.point().column);
    assert_eq!(1, iter.point().line);

    assert_indexed(4, iter.prev());
    assert_eq!(Column(4), iter.point().column);
    assert_eq!(0, iter.point().line);

    // Make sure iter.cell() returns the current iterator position.
    assert_eq!(&4, iter.cell());

    // Test that iter ends at end of grid.
    let mut final_iter = grid.iter_from(Point { line: Line(4), column: Column(4) });
    assert_eq!(None, final_iter.next());
    assert_indexed(23, final_iter.prev());
}

#[test]
fn shrink_reflow() {
    let mut grid = Grid::<Cell>::new(1, 5, 2);
    grid[Line(0)][Column(0)] = cell('1');
    grid[Line(0)][Column(1)] = cell('2');
    grid[Line(0)][Column(2)] = cell('3');
    grid[Line(0)][Column(3)] = cell('4');
    grid[Line(0)][Column(4)] = cell('5');

    grid.resize(true, 1, 2);

    // wmux: the cursor (at its default 0,0) is in this paragraph. xterm does
    // not reflow the cursor's paragraph (reflowCursorLine=false: Buffer.ts
    // `_reflowSmaller` lines 391-397, BufferReflow.ts
    // `reflowLargerGetLinesToRemove` lines 45-52), so neither does the grid.
    assert_eq!(grid.total_lines(), 1);

    assert_eq!(grid[Line(0)].len(), 2);
    assert_eq!(grid[Line(0)][Column(0)], cell('1'));
    assert_eq!(grid[Line(0)][Column(1)], cell('2'));
}

/// wmux: a narrowing records the rows its reflow added, also those trimmed at
/// the cap, for xterm's saved row (#3354); any other resize clears it.
#[test]
fn shrink_reflow_records_added_rows() {
    let filled = |max_scroll_limit| {
        let mut grid = Grid::<Cell>::new(2, 4, max_scroll_limit);
        for (i, c) in "1234".chars().enumerate() {
            grid[Line(0)][Column(i)] = cell(c);
        }
        // The cursor below that paragraph, so it reflows.
        grid.cursor.point.line = Line(1);
        grid
    };

    // No history allowed: the added row is trimmed, and still counted.
    let mut grid = filled(0);
    grid.resize(true, 2, 2);
    assert_eq!((grid.narrowing_added, grid.history_size()), (1, 0));

    // Room for it in the history.
    let mut grid = filled(1);
    grid.resize(true, 2, 2);
    assert_eq!((grid.narrowing_added, grid.history_size()), (1, 1));

    // A later widen clears it.
    grid.resize(true, 2, 4);
    assert_eq!(grid.narrowing_added, 0);
}

#[test]
fn shrink_reflow_twice() {
    let mut grid = Grid::<Cell>::new(1, 5, 2);
    grid[Line(0)][Column(0)] = cell('1');
    grid[Line(0)][Column(1)] = cell('2');
    grid[Line(0)][Column(2)] = cell('3');
    grid[Line(0)][Column(3)] = cell('4');
    grid[Line(0)][Column(4)] = cell('5');

    grid.resize(true, 1, 4);
    grid.resize(true, 1, 2);

    // wmux: the cursor (at its default 0,0) is in this paragraph. xterm does
    // not reflow the cursor's paragraph (reflowCursorLine=false: Buffer.ts
    // `_reflowSmaller` lines 391-397, BufferReflow.ts
    // `reflowLargerGetLinesToRemove` lines 45-52), so neither does the grid.
    assert_eq!(grid.total_lines(), 1);

    assert_eq!(grid[Line(0)].len(), 2);
    assert_eq!(grid[Line(0)][Column(0)], cell('1'));
    assert_eq!(grid[Line(0)][Column(1)], cell('2'));
}

#[test]
fn shrink_reflow_empty_cell_inside_line() {
    let mut grid = Grid::<Cell>::new(1, 5, 3);
    grid[Line(0)][Column(0)] = cell('1');
    grid[Line(0)][Column(1)] = Cell::default();
    grid[Line(0)][Column(2)] = cell('3');
    grid[Line(0)][Column(3)] = cell('4');
    grid[Line(0)][Column(4)] = Cell::default();

    grid.resize(true, 1, 2);

    // wmux: the cursor (at its default 0,0) is in this paragraph. xterm does
    // not reflow the cursor's paragraph (reflowCursorLine=false: Buffer.ts
    // `_reflowSmaller` lines 391-397, BufferReflow.ts
    // `reflowLargerGetLinesToRemove` lines 45-52), so neither does the grid.
    assert_eq!(grid.total_lines(), 1);

    assert_eq!(grid[Line(0)].len(), 2);
    assert_eq!(grid[Line(0)][Column(0)], cell('1'));
    assert_eq!(grid[Line(0)][Column(1)], Cell::default());

    grid.resize(true, 1, 1);

    assert_eq!(grid.total_lines(), 1);

    assert_eq!(grid[Line(0)].len(), 1);
    assert_eq!(grid[Line(0)][Column(0)], cell('1'));
}

#[test]
fn grow_reflow() {
    let mut grid = Grid::<Cell>::new(2, 2, 0);
    grid[Line(0)][Column(0)] = cell('1');
    grid[Line(0)][Column(1)] = wrap_cell('2');
    grid[Line(1)][Column(0)] = cell('3');
    grid[Line(1)][Column(1)] = Cell::default();

    grid.resize(true, 2, 3);

    // wmux: the cursor (at its default 0,0) is in this paragraph. xterm does
    // not reflow the cursor's paragraph (reflowCursorLine=false: Buffer.ts
    // `_reflowSmaller` lines 391-397, BufferReflow.ts
    // `reflowLargerGetLinesToRemove` lines 45-52), so neither does the grid.
    // The rows only grow, and the wrap stays on the first row's last cell.
    assert_eq!(grid.total_lines(), 2);

    assert_eq!(grid[Line(0)].len(), 3);
    assert_eq!(grid[Line(0)][Column(0)], cell('1'));
    assert_eq!(grid[Line(0)][Column(1)], cell('2'));
    assert_eq!(grid[Line(0)][Column(2)], wrap_cell(' '));

    assert_eq!(grid[Line(1)].len(), 3);
    assert_eq!(grid[Line(1)][Column(0)], cell('3'));
    assert_eq!(grid[Line(1)][Column(1)], Cell::default());
    assert_eq!(grid[Line(1)][Column(2)], Cell::default());
}

#[test]
fn grow_reflow_multiline() {
    let mut grid = Grid::<Cell>::new(3, 2, 0);
    grid[Line(0)][Column(0)] = cell('1');
    grid[Line(0)][Column(1)] = wrap_cell('2');
    grid[Line(1)][Column(0)] = cell('3');
    grid[Line(1)][Column(1)] = wrap_cell('4');
    grid[Line(2)][Column(0)] = cell('5');
    grid[Line(2)][Column(1)] = cell('6');

    grid.resize(true, 3, 6);

    // wmux: the cursor (at its default 0,0) is in this paragraph. xterm does
    // not reflow the cursor's paragraph (reflowCursorLine=false: Buffer.ts
    // `_reflowSmaller` lines 391-397, BufferReflow.ts
    // `reflowLargerGetLinesToRemove` lines 45-52), so neither does the grid.
    // The rows only grow, each wrap staying on its row's last cell.
    assert_eq!(grid.total_lines(), 3);

    let expected = [('1', '2', true), ('3', '4', true), ('5', '6', false)];
    for (r, &(a, b, wrapped)) in expected.iter().enumerate() {
        let row = &grid[Line(r as i32)];
        assert_eq!(row.len(), 6);
        assert_eq!(row[Column(0)], cell(a));
        assert_eq!(row[Column(1)], cell(b));
        for c in 2..5 {
            assert_eq!(row[Column(c)], Cell::default());
        }
        assert_eq!(row[Column(5)], if wrapped { wrap_cell(' ') } else { Cell::default() });
    }
}

// wmux: upstream's reflow cases above keep the cursor in the paragraph, which
// does not reflow; these keep it below, where it does.
#[test]
fn shrink_reflow_cursor_below() {
    let mut grid = Grid::<Cell>::new(2, 5, 2);
    for (x, c) in "12345".chars().enumerate() {
        grid[Line(0)][Column(x)] = cell(c);
    }
    grid.cursor.point.line = Line(1);

    grid.resize(true, 2, 2);

    // No room below the cursor: the added rows go to history, as in xterm.
    assert_eq!(grid.total_lines(), 4);
    assert_eq!(grid[Line(-2)][Column(0)], cell('1'));
    assert_eq!(grid[Line(-2)][Column(1)], wrap_cell('2'));
    assert_eq!(grid[Line(-1)][Column(0)], cell('3'));
    assert_eq!(grid[Line(-1)][Column(1)], wrap_cell('4'));
    assert_eq!(grid[Line(0)][Column(0)], cell('5'));
    assert_eq!(grid.cursor.point.line, Line(1));
}

#[test]
fn grow_reflow_below_the_cursor_moves_it_up_as_xterm() {
    // wmux: xterm counts every row a widen removes, below the cursor too:
    // each takes a history row first, then moves the cursor (and the saved
    // cursor) up one row (Buffer.ts `_reflowLargerAdjustViewport`).
    let paragraphs = |grid: &mut Grid<Cell>, from: i32| {
        for y in [from, from + 2] {
            grid[Line(y)][Column(0)] = cell('a');
            grid[Line(y)][Column(1)] = wrap_cell('b');
            grid[Line(y + 1)][Column(0)] = cell('c');
        }
    };
    // No history: two rows removed below, both cursors go up two.
    let mut grid = Grid::<Cell>::new(8, 2, 0);
    paragraphs(&mut grid, 4);
    grid.cursor.point.line = Line(3);
    grid.saved_cursor.point.line = Line(7);
    grid.resize(true, 8, 3);
    assert_eq!(grid.cursor.point.line, Line(1));
    assert_eq!(grid.saved_cursor.point.line, Line(5));
    // Clamped at the top.
    let mut grid = Grid::<Cell>::new(6, 2, 0);
    paragraphs(&mut grid, 1);
    grid.cursor.point.line = Line(0);
    grid.resize(true, 6, 3);
    assert_eq!(grid.cursor.point.line, Line(0));
    // One history row: it takes the first removed row, the cursors the other.
    let mut grid = Grid::<Cell>::new(6, 2, 10);
    grid.scroll_up(&(Line(0)..Line(6)), 1);
    paragraphs(&mut grid, 2);
    grid.cursor.point.line = Line(1);
    grid.saved_cursor.point.line = Line(5);
    assert_eq!(grid.history_size(), 1);
    grid.resize(true, 6, 3);
    assert_eq!(grid.history_size(), 0);
    assert_eq!(grid.cursor.point.line, Line(0));
    assert_eq!(grid.saved_cursor.point.line, Line(4));
}

#[test]
fn grow_reflow_cursor_below() {
    let mut grid = Grid::<Cell>::new(3, 2, 0);
    grid[Line(0)][Column(0)] = cell('1');
    grid[Line(0)][Column(1)] = wrap_cell('2');
    grid[Line(1)][Column(0)] = cell('3');
    grid.cursor.point.line = Line(2);

    grid.resize(true, 3, 3);

    // Unwrapped with no history: the cursor moves up and a blank row comes in.
    assert_eq!(grid.total_lines(), 3);
    assert_eq!(grid[Line(0)][Column(0)], cell('1'));
    assert_eq!(grid[Line(0)][Column(1)], cell('2'));
    assert_eq!(grid[Line(0)][Column(2)], cell('3'));
    for r in 1..3 {
        for c in 0..3 {
            assert_eq!(grid[Line(r)][Column(c)], Cell::default());
        }
    }
    assert_eq!(grid.cursor.point.line, Line(1));
}

#[test]
fn grow_reflow_disabled() {
    let mut grid = Grid::<Cell>::new(2, 2, 0);
    grid[Line(0)][Column(0)] = cell('1');
    grid[Line(0)][Column(1)] = wrap_cell('2');
    grid[Line(1)][Column(0)] = cell('3');
    grid[Line(1)][Column(1)] = Cell::default();

    grid.resize(false, 2, 3);

    assert_eq!(grid.total_lines(), 2);

    assert_eq!(grid[Line(0)].len(), 3);
    assert_eq!(grid[Line(0)][Column(0)], cell('1'));
    assert_eq!(grid[Line(0)][Column(1)], wrap_cell('2'));
    assert_eq!(grid[Line(0)][Column(2)], Cell::default());

    assert_eq!(grid[Line(1)].len(), 3);
    assert_eq!(grid[Line(1)][Column(0)], cell('3'));
    assert_eq!(grid[Line(1)][Column(1)], Cell::default());
    assert_eq!(grid[Line(1)][Column(2)], Cell::default());
}

#[test]
fn shrink_reflow_disabled() {
    let mut grid = Grid::<Cell>::new(1, 5, 2);
    grid[Line(0)][Column(0)] = cell('1');
    grid[Line(0)][Column(1)] = cell('2');
    grid[Line(0)][Column(2)] = cell('3');
    grid[Line(0)][Column(3)] = cell('4');
    grid[Line(0)][Column(4)] = cell('5');

    grid.resize(false, 1, 2);

    assert_eq!(grid.total_lines(), 1);

    assert_eq!(grid[Line(0)].len(), 2);
    assert_eq!(grid[Line(0)][Column(0)], cell('1'));
    assert_eq!(grid[Line(0)][Column(1)], cell('2'));
}

#[test]
fn accurate_size_hint() {
    let grid = Grid::<Cell>::new(5, 5, 2);

    size_hint_matches_count(grid.iter_from(Point::new(Line(0), Column(0))));
    size_hint_matches_count(grid.iter_from(Point::new(Line(2), Column(3))));
    size_hint_matches_count(grid.iter_from(Point::new(Line(4), Column(4))));
    size_hint_matches_count(grid.iter_from(Point::new(Line(4), Column(2))));
    size_hint_matches_count(grid.iter_from(Point::new(Line(10), Column(10))));
    size_hint_matches_count(grid.iter_from(Point::new(Line(2), Column(10))));

    let mut iterator = grid.iter_from(Point::new(Line(3), Column(1)));
    iterator.next();
    iterator.next();
    size_hint_matches_count(iterator);

    size_hint_matches_count(grid.display_iter());
}

fn size_hint_matches_count<T>(iter: impl Iterator<Item = T>) {
    let iterator = iter.into_iter();
    let (lower, upper) = iterator.size_hint();
    let count = iterator.count();
    assert_eq!(lower, count);
    assert_eq!(upper, Some(count));
}

#[test]
fn shrink_cursor_paragraph_resets_a_cut_wide_glyph() {
    // wmux: xterm's trim resets a fullwidth glyph whose lead lands in the new
    // last column to an empty cell and drops its trailing half
    // (`BufferLine.resize`); a soft-wrapped row keeps its wrap. Before a row
    // that starts with a fullwidth glyph, that empty cell is the glyph's wrap
    // gap to xterm, a leading spacer here.
    let wide = || {
        let mut lead = cell('한');
        lead.flags.insert(Flags::WIDE_CHAR);
        let mut spacer = Cell::default();
        spacer.flags.insert(Flags::WIDE_CHAR_SPACER);
        (lead, spacer)
    };
    let (lead, spacer) = wide();
    let cut_row = |grid: &mut Grid<Cell>| {
        grid[Line(0)][Column(0)] = cell('a');
        grid[Line(0)][Column(1)] = lead.clone();
        grid[Line(0)][Column(2)] = spacer.clone();
        grid[Line(0)][Column(3)] = cell('b');
        grid[Line(0)][Column(4)] = wrap_cell('c');
    };

    // The next row starts with a plain cell.
    let mut grid = Grid::<Cell>::new(2, 5, 0);
    cut_row(&mut grid);
    grid[Line(1)][Column(0)] = cell('a');
    grid[Line(1)][Column(1)] = lead.clone();
    grid[Line(1)][Column(2)] = spacer.clone();
    grid.cursor.point = Point::new(Line(1), Column(3));
    grid.resize(true, 2, 2);
    assert_eq!(grid[Line(0)].len(), 2);
    assert_eq!(grid[Line(0)][Column(0)], cell('a'));
    let mut wrapped_blank = Cell::default();
    wrapped_blank.flags.insert(Flags::WRAPLINE);
    assert_eq!(grid[Line(0)][Column(1)], wrapped_blank);
    assert_eq!(grid[Line(1)][Column(0)], cell('a'));
    assert_eq!(grid[Line(1)][Column(1)], Cell::default());
    assert_eq!(grid.cursor.point, Point::new(Line(1), Column(1)));
    assert!(!grid.cursor.input_needs_wrap);

    // The next row starts with a fullwidth glyph.
    let mut grid = Grid::<Cell>::new(2, 5, 0);
    cut_row(&mut grid);
    grid[Line(1)][Column(0)] = lead.clone();
    grid[Line(1)][Column(1)] = spacer.clone();
    grid[Line(1)][Column(2)] = cell('x');
    grid.cursor.point = Point::new(Line(1), Column(3));
    grid.resize(true, 2, 2);
    let mut gap = Cell::default();
    gap.flags.insert(Flags::LEADING_WIDE_CHAR_SPACER | Flags::WRAPLINE);
    assert_eq!(grid[Line(0)][Column(1)], gap);
    assert_eq!(grid[Line(1)][Column(0)], lead);
    assert_eq!(grid[Line(1)][Column(1)], spacer);
}

// https://github.com/rust-lang/rust-clippy/pull/6375
#[allow(clippy::all)]
fn cell(c: char) -> Cell {
    let mut cell = Cell::default();
    cell.c = c;
    cell
}

fn wrap_cell(c: char) -> Cell {
    let mut cell = cell(c);
    cell.flags.insert(Flags::WRAPLINE);
    cell
}
