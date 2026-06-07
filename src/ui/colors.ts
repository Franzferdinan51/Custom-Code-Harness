// Small ANSI color helpers. We do NOT depend on a library — the harness
// works fine without colors, and we want to keep the dependency tree
// empty.

const enabled =
  process.env.NO_COLOR === undefined &&
  process.env.CODINGHARNESS_COLOR !== "never" &&
  (process.env.CODINGHARNESS_COLOR === "always" || (process.stdout.isTTY ?? false));

function wrap(open: number, close: number): (s: string) => string {
  if (!enabled) return (s) => s;
  return (s) => `\x1b[${open}m${s}\x1b[${close}m`;
}

export const c = {
  dim: wrap(2, 22),
  bold: wrap(1, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

export const enabled_ = enabled;
