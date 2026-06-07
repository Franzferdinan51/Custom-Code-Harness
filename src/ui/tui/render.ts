// Diff-based renderer: compare the current buffer to the "last drawn"
// state and emit only the changes. This is what keeps the TUI from
// flickering while streaming tokens.

import { Buffer, type Cell, type Style, styleToSgr } from "./buffer.js";

export class Renderer {
  private last: Cell[][] = [];
  private lastStyle: Style | undefined;
  private write: (s: string) => void;

  constructor(write: (s: string) => void) {
    this.write = write;
  }

  /** Allocate the last-draw grid to match the new buffer. */
  reset(cols: number, rows: number): void {
    this.last = [];
    for (let r = 0; r < rows; r++) {
      const row: Cell[] = [];
      for (let c = 0; c < cols; c++) row.push({ char: " ", style: {} });
      this.last.push(row);
    }
    this.lastStyle = undefined;
    this.write("\x1b[2J\x1b[H");
  }

  /** Render the buffer, only writing changed cells. */
  render(buf: Buffer): void {
    // Resize last grid if needed.
    if (this.last.length !== buf.rows || (this.last[0]?.length ?? 0) !== buf.cols) {
      this.reset(buf.cols, buf.rows);
    }
    let currentStyle: Style | undefined = this.lastStyle;
    let pending = "";
    const flush = () => {
      if (pending.length > 0) {
        this.write(pending);
        pending = "";
      }
    };
    for (let r = 0; r < buf.rows; r++) {
      for (let c = 0; c < buf.cols; c++) {
        const cell = buf.getCell(r, c);
        const prev = this.last[r]?.[c] ?? { char: " ", style: {} };
        if (cell.char === prev.char && styleEqual(cell.style, prev.style)) continue;
        // Move cursor.
        pending += "\x1b[" + (r + 1) + ";" + (c + 1) + "H";
        // Update style if changed.
        if (!styleEqual(cell.style, currentStyle)) {
          pending += styleToSgr(cell.style, currentStyle);
          currentStyle = cell.style;
        }
        pending += cell.char;
        this.last[r]![c] = { char: cell.char, style: cell.style };
      }
    }
    flush();
    this.lastStyle = currentStyle;
  }

  /** Move the terminal cursor to (row, col) and show it. */
  showCursor(row: number, col: number): void {
    this.write("\x1b[" + (row + 1) + ";" + (col + 1) + "H\x1b[?25h");
  }
  hideCursor(): void {
    this.write("\x1b[?25l");
  }
}

function styleEqual(a?: Style, b?: Style): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.bold === b.bold && a.dim === b.dim && a.italic === b.italic && a.underline === b.underline && a.inverse === b.inverse && a.fg === b.fg && a.bg === b.bg;
}
