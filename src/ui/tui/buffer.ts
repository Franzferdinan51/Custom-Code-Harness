// 2D styled-cell buffer for the TUI. The buffer represents the entire
// screen as rows × cols of "cells". Each cell holds a single character
// and a style (SGR). The renderer diffs the buffer against the actual
// terminal state and writes only the changed cells.

export interface Style {
  fg?: number;     // 0-255
  bg?: number;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

export interface Cell {
  char: string;
  style: Style;
}

export const EMPTY_CELL: Cell = { char: " ", style: {} };

/** A 2D buffer of cells. Indexable by [row][col]. */
export class Buffer {
  cols: number;
  rows: number;
  private grid: Cell[][];

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.grid = makeGrid(cols, rows);
  }

  /** Resize the buffer, preserving content where possible. */
  resize(cols: number, rows: number): void {
    const old = this.grid;
    const newGrid = makeGrid(cols, rows);
    for (let r = 0; r < Math.min(rows, old.length); r++) {
      for (let c = 0; c < Math.min(cols, old[r]!.length); c++) {
        newGrid[r]![c] = old[r]![c]!;
      }
    }
    this.cols = cols;
    this.rows = rows;
    this.grid = newGrid;
  }

  /** Clear the entire buffer to EMPTY_CELL with no style. */
  clear(): void {
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        this.grid[r]![c] = EMPTY_CELL;
      }
    }
  }

  /** Write a single styled char at (row, col). Clips if out of bounds. */
  setCell(row: number, col: number, ch: string, style: Style = {}): void {
    if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) return;
    this.grid[row]![col] = { char: ch, style };
  }

  /** Get the cell at (row, col). Returns EMPTY_CELL if out of bounds. */
  getCell(row: number, col: number): Cell {
    if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) return EMPTY_CELL;
    return this.grid[row]![col]!;
  }

  /** Write a string starting at (row, col). Wraps to next row on
   *  overflow. Returns the (row, col) of the cell AFTER the last
   *  written char. Newlines in the string create new rows. */
  writeString(row: number, col: number, text: string, style: Style = {}): { row: number; col: number } {
    let r = row;
    let c = col;
    let i = 0;
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === "\n") {
        r++;
        c = 0;
        i++;
        continue;
      }
      if (c >= this.cols) {
        r++;
        c = 0;
        if (r >= this.rows) break;
      }
      this.setCell(r, c, ch, style);
      c++;
      i++;
    }
    return { row: r, col: c };
  }

  /** Draw a horizontal divider on a row. */
  drawHLine(row: number, col: number, length: number, char: string = "─", style: Style = {}): void {
    for (let i = 0; i < length; i++) this.setCell(row, col + i, char, style);
  }

  /** Fill a rectangular region with a single char + style. */
  fillRect(row: number, col: number, width: number, height: number, char: string = " ", style: Style = {}): void {
    for (let r = 0; r < height; r++) {
      for (let c = 0; c < width; c++) {
        this.setCell(row + r, col + c, char, style);
      }
    }
  }
}

function makeGrid(cols: number, rows: number): Cell[][] {
  const grid: Cell[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < cols; c++) row.push(EMPTY_CELL);
    grid.push(row);
  }
  return grid;
}

/** Convert a Style to an SGR escape sequence. */
export function styleToSgr(s: Style, prev?: Style): string {
  if (prev && stylesEqual(s, prev)) return "";
  const codes: number[] = [];
  // Reset (then re-apply fg/bg) if we differ.
  const needReset = !prev || (prev.bold !== s.bold) || (prev.dim !== s.dim) || (prev.italic !== s.italic) || (prev.underline !== s.underline) || (prev.inverse !== s.inverse) || (prev.fg !== s.fg) || (prev.bg !== s.bg);
  if (needReset) {
    codes.push(0);
    if (s.bold) codes.push(1);
    if (s.dim) codes.push(2);
    if (s.italic) codes.push(3);
    if (s.underline) codes.push(4);
    if (s.inverse) codes.push(7);
    if (s.fg !== undefined) codes.push(s.fg >= 0 && s.fg <= 7 ? 30 + s.fg : s.fg >= 8 && s.fg <= 15 ? 90 + (s.fg - 8) : 38);
    if (s.bg !== undefined) codes.push(s.bg >= 0 && s.bg <= 7 ? 40 + s.bg : s.bg >= 8 && s.bg <= 15 ? 100 + (s.bg - 8) : 48);
    // For extended 256 colors, append "5;n" after the introducer.
    if (s.fg !== undefined && s.fg >= 16) codes.push(s.fg);
    if (s.bg !== undefined && s.bg >= 16) codes.push(s.bg);
  }
  return codes.length > 0 ? "\x1b[" + codes.join(";") + "m" : "";
}

function stylesEqual(a: Style, b: Style): boolean {
  return a.bold === b.bold && a.dim === b.dim && a.italic === b.italic && a.underline === b.underline && a.inverse === b.inverse && a.fg === b.fg && a.bg === b.bg;
}
