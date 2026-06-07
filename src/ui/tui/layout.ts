// Layout: divides the screen into regions for the TUI.
//
//   ┌─ header (1-2 lines) ──────────────────────────┐
//   │                                                │
//   │   message area (scrollable)                    │
//   │                                                │
//   ├─ separator ────────────────────────────────────┤
//   │   input area (multi-line, 1-5 lines)          │
//   ├─ footer (1 line) ─────────────────────────────┤
//   └────────────────────────────────────────────────┘

export interface Layout {
  headerRow: number;       // first row of header
  headerRows: number;      // number of rows
  messagesRow: number;     // first row of message area
  messagesRows: number;    // number of rows
  inputRow: number;        // first row of input area
  inputRows: number;       // number of rows
  footerRow: number;       // first row of footer
}

export function computeLayout(cols: number, rows: number): Layout {
  // Header: 2 lines (top status + provider/model)
  const headerRows = 2;
  // Footer: 2 lines (keybinds + bottom bar)
  const footerRows = 2;
  // Input: at least 1, at most 5. We don't know in advance how many
  // lines the user will type, so we reserve 3 and the renderer can
  // adjust on the fly if needed.
  const inputRows = 3;
  const total = rows;
  const used = headerRows + footerRows + inputRows;
  const messagesRows = Math.max(3, total - used);
  return {
    headerRow: 0,
    headerRows,
    messagesRow: headerRows,
    messagesRows,
    inputRow: headerRows + messagesRows,
    inputRows,
    footerRow: headerRows + messagesRows + inputRows,
  };
}
