// Interactive approval modal.
//
// When the agent tries to run a bash command that's blocked by the
// approval flow, we pop a small modal at the top of the screen asking
// the user to confirm. The user can:
//   - y / Enter: approve this command once
//   - a:     approve for the rest of this session
//   - n:     deny
//   - Esc:   deny
//
// The modal returns a Promise<boolean | "always">. The runtime uses
// this to decide whether to re-run the command with __approval_bypass.

import { BoxRenderable, TextRenderable, RGBA, type CliRenderer } from "@opentui/core";

const COLORS = {
  bg:        RGBA.fromHex("#1a1f29"),
  border:    RGBA.fromHex("#ffd166"),
  fg:        RGBA.fromHex("#e6e6e6"),
  fgDim:     RGBA.fromHex("#7a8190"),
  fgYellow:  RGBA.fromHex("#ffd166"),
  fgGreen:   RGBA.fromHex("#7ed4a3"),
  fgRed:     RGBA.fromHex("#ff6b6b"),
  fgCyan:    RGBA.fromHex("#5ed1ff"),
} as const;

export type ApprovalDecision = "allow-once" | "allow-always" | "deny";

export async function askApproval(
  renderer: CliRenderer,
  command: string,
  reason: string,
  parent: BoxRenderable
): Promise<ApprovalDecision> {
  // Build the modal overlay. We insert it as a child of `parent` (the
  // root) on top of everything else, then remove it on resolve.
  const overlay = new BoxRenderable(renderer, {
    id: "approval-modal",
    backgroundColor: COLORS.bg,
    borderStyle: "double",
    border: true,
    borderColor: COLORS.border,
    flexDirection: "column",
    alignItems: "stretch",
    alignSelf: "center",
    width: Math.min(72, renderer.width - 4),
    paddingLeft: 2,
    paddingRight: 2,
    paddingTop: 1,
    paddingBottom: 1,
    zIndex: 1000,
  });
  parent.add(overlay);

  const title = new TextRenderable(renderer, { id: "ap-title", content: "  ⚠ Bash command requires approval", fg: COLORS.fgYellow, attributes: 1 });
  overlay.add(title);

  const reasonLine = new TextRenderable(renderer, { id: "ap-reason", content: "  Reason: " + reason, fg: COLORS.fgDim });
  overlay.add(reasonLine);

  const cmdLine = new TextRenderable(renderer, { id: "ap-cmd", content: "  Command:", fg: COLORS.fgDim });
  overlay.add(cmdLine);
  const cmdText = new TextRenderable(renderer, { id: "ap-cmd-text", content: "  " + command.slice(0, 64) + (command.length > 64 ? "…" : ""), fg: COLORS.fg });
  overlay.add(cmdText);

  const spacer = new TextRenderable(renderer, { id: "ap-spacer", content: "", fg: COLORS.fgDim });
  overlay.add(spacer);

  const help = new TextRenderable(renderer, { id: "ap-help", content: "  y allow once · a always · n deny · Esc cancel", fg: COLORS.fgCyan });
  overlay.add(help);

  return await new Promise<ApprovalDecision>((resolve) => {
    let resolved = false;
    const handler = (sequence: string): boolean => {
      if (resolved) return false;
      if (sequence === "y" || sequence === "\r" || sequence === "\n") {
        resolved = true; cleanup("allow-once"); return true;
      }
      if (sequence === "a" || sequence === "A") {
        resolved = true; cleanup("allow-always"); return true;
      }
      if (sequence === "n" || sequence === "N" || sequence === "\x1b") {
        resolved = true; cleanup("deny"); return true;
      }
      return false;
    };
    renderer.addInputHandler(handler);
    function cleanup(decision: ApprovalDecision): void {
      try { parent.remove("approval-modal"); } catch { /* ignore */ }
      try { renderer.removeInputHandler(handler); } catch { /* ignore */ }
      resolve(decision);
    }
  });
}
