//! Grid resize and reflow.

use std::cmp::{Ordering, max, min};
use std::mem;

use crate::index::{Boundary, Column, Line};
use crate::term::cell::{Flags, ResetDiscriminant};

use crate::grid::row::Row;
use crate::grid::{Dimensions, Grid, GridCell};

impl<T: GridCell + Default + PartialEq> Grid<T> {
    // wmux: xterm's default reflowCursorLine=false leaves the entire cursor
    // paragraph in place. Storage indices run from the bottom towards history.
    fn cursor_paragraph(&self) -> std::ops::RangeInclusive<usize> {
        let mut first = self.cursor.point.line;
        let mut last = first;
        while first > self.topmost_line()
            && self[Line(first.0 - 1)][self.last_column()].flags().contains(Flags::WRAPLINE)
        {
            first -= 1;
        }
        while last < self.bottommost_line()
            && self[last][self.last_column()].flags().contains(Flags::WRAPLINE)
        {
            last += 1;
        }
        (self.lines as i32 - last.0 - 1) as usize
            ..=(self.lines as i32 - first.0 - 1) as usize
    }

    fn resize_cursor_row(row: &mut Row<T>, columns: usize) {
        let wrapped = row.take_wrap();
        let old = row.len();
        if row.len() > columns {
            row.shrink(columns);
        } else { row.grow(columns); }
        // wmux: a soft-wrapped row grown here has empty cells xterm never
        // wrote (its paragraph is not reflowed); the serializer keeps them so.
        if wrapped && old < columns {
            row.set_empty_from(old);
        }
        if wrapped { row.put_wrap(); }
    }

    /// Resize the grid's width and/or height.
    pub fn resize<D>(&mut self, reflow: bool, lines: usize, columns: usize)
    where
        T: ResetDiscriminant<D>,
        D: PartialEq,
    {
        // Use empty template cell for resetting cells due to resize.
        let template = mem::take(&mut self.cursor.template);

        match self.lines.cmp(&lines) {
            Ordering::Less => self.grow_lines(lines),
            Ordering::Greater => self.shrink_lines(lines),
            Ordering::Equal => (),
        }

        match self.columns.cmp(&columns) {
            Ordering::Less => self.grow_columns(reflow, columns),
            Ordering::Greater => self.shrink_columns(reflow, columns),
            Ordering::Equal => (),
        }

        // Restore template cell.
        self.cursor.template = template;
    }

    /// Add lines to the visible area.
    ///
    /// Alacritty keeps the cursor at the bottom of the terminal as long as there
    /// is scrollback available. Once scrollback is exhausted, new lines are
    /// simply added to the bottom of the screen.
    fn grow_lines<D>(&mut self, target: usize)
    where
        T: ResetDiscriminant<D>,
        D: PartialEq,
    {
        let lines_added = target - self.lines;

        // wmux: xterm pulls history rows down only while the cursor is on the
        // bottom row; otherwise it adds blank rows below and history stays put
        // (Buffer.ts resize, rows grow). Growing the window takes rows from the
        // top of history and leaves blank rows at its far end; rotating by the
        // rows added brings those blank rows to the bottom instead, so no
        // history row is lost even at the scrollback cap.
        if self.cursor.point.line.0 + 1 < self.lines as i32 {
            self.raw.grow_visible_lines(target);
            self.lines = target;
            self.raw.rotate(-(lines_added as isize));
            for line in (target - lines_added)..target {
                self.raw[Line(line as i32)].reset(&self.cursor.template);
            }
            return;
        }

        // Need to resize before updating buffer.
        self.raw.grow_visible_lines(target);
        self.lines = target;

        let history_size = self.history_size();
        let from_history = min(history_size, lines_added);

        // Move existing lines up for every line that couldn't be pulled from history.
        if from_history != lines_added {
            let delta = lines_added - from_history;
            self.scroll_up(&(Line(0)..Line(target as i32)), delta);
        }

        // Move cursor down for every line pulled from history.
        self.saved_cursor.point.line += from_history;
        self.cursor.point.line += from_history;

        self.display_offset = self.display_offset.saturating_sub(lines_added);
        self.decrease_scroll_limit(lines_added);
    }

    /// Remove lines from the visible area.
    ///
    /// The behavior in Terminal.app and iTerm.app is to keep the cursor at the
    /// bottom of the screen. This is achieved by pushing history "out the top"
    /// of the terminal window.
    ///
    /// Alacritty takes the same approach.
    fn shrink_lines<D>(&mut self, target: usize)
    where
        T: ResetDiscriminant<D>,
        D: PartialEq,
    {
        // Scroll up to keep content inside the window.
        let required_scrolling = (self.cursor.point.line.0 as usize + 1).saturating_sub(target);
        if required_scrolling > 0 {
            self.scroll_up(&(Line(0)..Line(self.lines as i32)), required_scrolling);

            // Clamp cursors to the new viewport size.
            self.cursor.point.line = min(self.cursor.point.line, Line(target as i32 - 1));
        }

        // Clamp saved cursor, since only primary cursor is scrolled into viewport.
        self.saved_cursor.point.line = min(self.saved_cursor.point.line, Line(target as i32 - 1));

        self.raw.rotate((self.lines - target) as isize);
        self.raw.shrink_visible_lines(target);
        self.lines = target;
    }

    /// Grow number of columns in each row, reflowing if necessary.
    fn grow_columns(&mut self, reflow: bool, columns: usize) {
        let cursor_paragraph = self.cursor_paragraph();
        // wmux: what xterm's widening reads (see the end of this function).
        let history_before = self.history_size();
        let total_before = self.total_lines();
        let cursor_line_before = self.cursor.point.line;
        let saved_line_before = self.saved_cursor.point.line;
        // Check if a row needs to be wrapped.
        let should_reflow = |row: &Row<T>| -> bool {
            let len = Column(row.len());
            reflow && len.0 > 0 && len < columns && row[len - 1].flags().contains(Flags::WRAPLINE)
        };

        self.columns = columns;

        let mut reversed: Vec<Row<T>> = Vec::with_capacity(self.raw.len());
        let mut cursor_line_delta = 0;

        // Remove the linewrap special case, by moving the cursor outside of the grid.
        if self.cursor.input_needs_wrap && reflow {
            self.cursor.input_needs_wrap = false;
            self.cursor.point.column += 1;
        }

        let mut rows = self.raw.take_all();

        for (i, mut row) in rows.drain(..).enumerate().rev() {
            if reflow && cursor_paragraph.contains(&i) {
                Self::resize_cursor_row(&mut row, columns);
                reversed.push(row);
                continue;
            }
            // Check if reflowing should be performed.
            let last_row = match reversed.last_mut() {
                Some(last_row) if should_reflow(last_row) => last_row,
                _ => {
                    reversed.push(row);
                    continue;
                },
            };

            // Remove wrap flag before appending additional cells.
            if let Some(cell) = last_row.last_mut() {
                cell.flags_mut().remove(Flags::WRAPLINE);
            }

            // Remove leading spacers when reflowing wide char to the previous line.
            let mut last_len = last_row.len();
            if last_len >= 1
                && last_row[Column(last_len - 1)].flags().contains(Flags::LEADING_WIDE_CHAR_SPACER)
            {
                last_row.shrink(last_len - 1);
                last_len -= 1;
            }

            // Don't try to pull more cells from the next line than available.
            let mut num_wrapped = columns - last_len;
            let len = min(row.len(), num_wrapped);

            // Insert leading spacer when there's not enough room for reflowing wide char.
            let mut cells = if row[Column(len - 1)].flags().contains(Flags::WIDE_CHAR) {
                num_wrapped -= 1;

                let mut cells = row.front_split_off(len - 1);

                let mut spacer = T::default();
                spacer.flags_mut().insert(Flags::LEADING_WIDE_CHAR_SPACER);
                cells.push(spacer);

                cells
            } else {
                row.front_split_off(len)
            };

            // Add removed cells to previous row and reflow content.
            last_row.append(&mut cells);

            let cursor_buffer_line = self.lines - self.cursor.point.line.0 as usize - 1;

            if i == cursor_buffer_line && reflow {
                // Resize cursor's line and reflow the cursor if necessary.
                let mut target = self.cursor.point.sub(self, Boundary::Cursor, num_wrapped);

                // Clamp to the last column, if no content was reflown with the cursor.
                if target.column.0 == 0 && row.is_clear() {
                    self.cursor.input_needs_wrap = true;
                    target = target.sub(self, Boundary::Cursor, 1);
                }
                self.cursor.point.column = target.column;

                // Get required cursor line changes. Since `num_wrapped` is smaller than `columns`
                // this will always be either `0` or `1`.
                let line_delta = self.cursor.point.line - target.line;

                if line_delta != 0 && row.is_clear() {
                    continue;
                }

                cursor_line_delta += line_delta.0 as usize;
            } else if row.is_clear() {
                if i < self.display_offset {
                    // Since we removed a line, rotate down the viewport.
                    self.display_offset = self.display_offset.saturating_sub(1);
                }

                // Rotate cursor down if content below them was pulled from history.
                if i < cursor_buffer_line {
                    self.cursor.point.line += 1;
                }

                // Don't push line into the new buffer.
                continue;
            }

            if let Some(cell) = last_row.last_mut() {
                // Set wrap flag if next line still has cells.
                cell.flags_mut().insert(Flags::WRAPLINE);
            }

            reversed.push(row);
        }

        let removed = total_before.saturating_sub(reversed.len());

        // Make sure we have at least the viewport filled.
        if reversed.len() < self.lines {
            let delta = (self.lines - reversed.len()) as i32;
            self.cursor.point.line = max(self.cursor.point.line - delta, Line(0));
            reversed.resize_with(self.lines, || Row::new(columns));
        }

        // Pull content down to put cursor in correct position, or move cursor up if there's no
        // more lines to delete below the cursor.
        if cursor_line_delta != 0 {
            let cursor_buffer_line = self.lines - self.cursor.point.line.0 as usize - 1;
            let available = min(cursor_buffer_line, reversed.len() - self.lines);
            let overflow = cursor_line_delta.saturating_sub(available);
            reversed.truncate(reversed.len() + overflow - cursor_line_delta);
            self.cursor.point.line = max(self.cursor.point.line - overflow, Line(0));
        }

        // Reverse iterator and fill all rows that are still too short.
        let mut new_raw = Vec::with_capacity(reversed.len());
        for mut row in reversed.drain(..).rev() {
            if row.len() < columns {
                row.grow(columns);
            }
            new_raw.push(row);
        }

        self.raw.replace_inner(new_raw);

        // Clamp display offset in case lines above it got merged.
        self.display_offset = min(self.display_offset, self.history_size());

        // wmux: xterm counts every row the reflow removed, above or below the
        // cursor, and moves its cursor row by its own rule, not with its
        // content (Buffer.ts `_reflowLargerAdjustViewport`). Each removed row
        // first takes one history row, then moves the cursor up one row while
        // it is below the top. The saved cursor (`savedY`, absolute there)
        // moves up by every removed row, which on this screen-relative line
        // is the same rule.
        if reflow {
            let up = removed.saturating_sub(history_before) as i32;
            self.cursor.point.line = max(cursor_line_before - up, Line(0));
            self.saved_cursor.point.line = max(saved_line_before - up, Line(0));
        }
    }

    /// Shrink number of columns in each row, reflowing if necessary.
    fn shrink_columns(&mut self, reflow: bool, columns: usize) {
        let cursor_paragraph = self.cursor_paragraph();
        // wmux: what xterm's narrowing reads (see the end of this function).
        let history_before = self.history_size();
        let total_before = self.total_lines();
        let cursor_line_before = self.cursor.point.line;
        let saved_line_before = self.saved_cursor.point.line;
        self.columns = columns;

        // Remove the linewrap special case, by moving the cursor outside of the grid.
        if self.cursor.input_needs_wrap && reflow {
            self.cursor.input_needs_wrap = false;
            self.cursor.point.column += 1;
        }

        let mut new_raw = Vec::with_capacity(self.raw.len());
        let mut buffered: Option<Vec<T>> = None;

        let mut rows = self.raw.take_all();
        for (i, mut row) in rows.drain(..).enumerate().rev() {
            if reflow && cursor_paragraph.contains(&i) {
                Self::resize_cursor_row(&mut row, columns);
                new_raw.push(row);
                continue;
            }
            // wmux: without reflow (the alternate screen) xterm keeps a line's
            // cells past the narrower width; a later widen shows them again.
            if !reflow {
                row.hide_past(columns);
                new_raw.push(row);
                continue;
            }
            // Append lines left over from the previous row.
            if let Some(buffered) = buffered.take() {
                // Add a column for every cell added before the cursor, if it goes beyond the new
                // width it is then later reflown.
                let cursor_buffer_line = self.lines - self.cursor.point.line.0 as usize - 1;
                if i == cursor_buffer_line {
                    self.cursor.point.column += buffered.len();
                }

                row.append_front(buffered);
            }

            loop {
                // Remove all cells which require reflowing.
                let mut wrapped = match row.shrink(columns) {
                    Some(wrapped) if reflow => wrapped,
                    _ => {
                        let cursor_buffer_line = self.lines - self.cursor.point.line.0 as usize - 1;
                        if reflow && i == cursor_buffer_line && self.cursor.point.column > columns {
                            // If there are empty cells before the cursor, we assume it is explicit
                            // whitespace and need to wrap it like normal content.
                            Vec::new()
                        } else {
                            // Since it fits, just push the existing line without any reflow.
                            new_raw.push(row);
                            break;
                        }
                    },
                };

                // Insert spacer if a wide char would be wrapped into the last column.
                if row.len() >= columns
                    && row[Column(columns - 1)].flags().contains(Flags::WIDE_CHAR)
                {
                    let mut spacer = T::default();
                    spacer.flags_mut().insert(Flags::LEADING_WIDE_CHAR_SPACER);

                    let wide_char = mem::replace(&mut row[Column(columns - 1)], spacer);
                    wrapped.insert(0, wide_char);
                }

                // Remove wide char spacer before shrinking.
                let len = wrapped.len();
                if len > 0 && wrapped[len - 1].flags().contains(Flags::LEADING_WIDE_CHAR_SPACER) {
                    if len == 1 {
                        row[Column(columns - 1)].flags_mut().insert(Flags::WRAPLINE);
                        new_raw.push(row);
                        break;
                    } else {
                        // Remove the leading spacer from the end of the wrapped row.
                        wrapped[len - 2].flags_mut().insert(Flags::WRAPLINE);
                        wrapped.truncate(len - 1);
                    }
                }

                new_raw.push(row);

                // Set line as wrapped if cells got removed.
                if let Some(cell) = new_raw.last_mut().and_then(|r| r.last_mut()) {
                    cell.flags_mut().insert(Flags::WRAPLINE);
                }

                if wrapped
                    .last()
                    .map(|c| c.flags().contains(Flags::WRAPLINE) && i >= 1)
                    .unwrap_or(false)
                    && wrapped.len() < columns
                {
                    // Make sure previous wrap flag doesn't linger around.
                    if let Some(cell) = wrapped.last_mut() {
                        cell.flags_mut().remove(Flags::WRAPLINE);
                    }

                    // Add removed cells to start of next row.
                    buffered = Some(wrapped);
                    break;
                } else {
                    // Reflow cursor if a line below it is deleted.
                    let cursor_buffer_line = self.lines - self.cursor.point.line.0 as usize - 1;
                    if (i == cursor_buffer_line && self.cursor.point.column < columns)
                        || i < cursor_buffer_line
                    {
                        self.cursor.point.line = max(self.cursor.point.line - 1, Line(0));
                    }

                    // Reflow the cursor if it is on this line beyond the width.
                    if i == cursor_buffer_line && self.cursor.point.column >= columns {
                        // Since only a single new line is created, we subtract only `columns`
                        // from the cursor instead of reflowing it completely.
                        self.cursor.point.column -= columns;
                    }

                    // Make sure new row is at least as long as new width.
                    let occ = wrapped.len();
                    if occ < columns {
                        wrapped.resize_with(columns, T::default);
                    }
                    row = Row::from_vec(wrapped, occ);

                    if i < self.display_offset {
                        // Since we added a new line, rotate up the viewport.
                        self.display_offset += 1;
                    }
                }
            }
        }

        // Reverse iterator and use it as the new grid storage.
        let mut reversed: Vec<Row<T>> = new_raw.drain(..).rev().collect();
        let added = reversed.len().saturating_sub(total_before);
        let last = Line(self.lines as i32 - 1);
        let kept = if reflow && history_before == 0 {
            min(added, (last.0 - cursor_line_before.0).max(0) as usize)
        } else {
            0
        };
        // The rows kept on screen below are dropped from the bottom, so keep
        // them past the history cap here.
        reversed.truncate(self.max_scroll_limit + self.lines + kept);
        self.raw.replace_inner(reversed);

        // wmux: xterm counts every row the reflow added, above or below the
        // cursor, and moves its cursor row by its own rule, not with its
        // content (Buffer.ts `_reflowSmaller`, the viewport adjustment). With
        // no history it moves the cursor down one row per added row while
        // there is room, dropping the bottom row each time; the rest goes to
        // history. With history it leaves the cursor row as it was. The saved
        // cursor moves down with the room used (`savedY` is absolute there).
        if reflow {
            if history_before == 0 {
                if kept > 0 {
                    // Bring the rows pushed into history back on screen and
                    // drop as many from the bottom, as xterm pops them.
                    self.raw.rotate(kept as isize);
                    self.raw.shrink_lines(kept);
                }
                self.cursor.point.line = cursor_line_before + kept;
                self.saved_cursor.point.line = min(saved_line_before + kept, last);
            } else {
                self.cursor.point.line = cursor_line_before;
            }
        }

        // Clamp display offset in case some lines went off.
        self.display_offset = min(self.display_offset, self.history_size());

        // wmux: the cursor paragraph was not reflowed. xterm clamps its cursor
        // and clears pending wrap after a shrink, even if older lines reflowed.
        self.cursor.point.column = min(self.cursor.point.column, Column(columns - 1));
        self.cursor.input_needs_wrap = false;

        // Clamp the saved cursor to the grid.
        self.saved_cursor.point.column = min(self.saved_cursor.point.column, Column(columns - 1));
    }
}
