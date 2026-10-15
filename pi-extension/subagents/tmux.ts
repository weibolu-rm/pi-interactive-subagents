/**
 * tmux surface layer — the only terminal multiplexer this extension supports.
 *
 * Everything the extension does to a pane goes through the small API in this
 * file: create/split a pane, type a command into it, read its screen, close
 * it, and poll for exit. Keeping the tmux calls isolated here means index.ts
 * stays testable without a multiplexer running.
 *
 * Panes are identified by tmux pane ids (e.g. `%12`). By default sub-agent
 * panes live in a dedicated shared window, separate from the orchestrator's
 * window, so spawning never resizes it or disturbs a zoomed pane (prefix z).
 * The low-level split primitive targets the parent pi's pane (`$TMUX_PANE`)
 * so it follows the agent rather than the user's focus.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

// ── Availability ──

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    available = true;
  } catch {
    available = false;
  }

  commandAvailability.set(command, available);
  return available;
}

/**
 * True when running inside tmux with the tmux binary on PATH.
 * `TMUX` is set by tmux in every process it spawns (shell or pane).
 */
export function isTmuxAvailable(): boolean {
  return !!process.env.TMUX && hasCommand("tmux");
}

export function isMuxAvailable(): boolean {
  return isTmuxAvailable();
}

export function muxSetupHint(): string {
  return "Start pi inside tmux (`tmux new -A -s pi 'pi'`).";
}

function requireTmux(): void {
  if (!isTmuxAvailable()) {
    throw new Error(`tmux is required for subagents. ${muxSetupHint()}`);
  }
}

// ── Shell helpers ──

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ── Pane placement ──

/**
 * tmux layout applied to the subagent window to keep panes evenly sized.
 * Switchable: "even-horizontal" (equal columns, matches Ctrl+b Alt+1),
 * "main-vertical" (big main pane + tiled column), "tiled" (grid).
 */
const SUBAGENT_TMUX_LAYOUT = "even-horizontal";

/**
 * Name of the dedicated tmux window that hosts sub-agent panes. Override
 * with PI_SUBAGENT_WINDOW_NAME. The window is found again by this name and
 * by the `@pi-subagents` window marker (which stores this name and survives
 * manual window renames), so every pi orchestrator in the session —
 * including nested sub-agents — shares a single observability window
 * instead of each spawning its own.
 */
function subagentWindowName(): string {
  return process.env.PI_SUBAGENT_WINDOW_NAME ?? "pi-subagents";
}

/**
 * Where sub-agent panes are created:
 * - "window" (default): inside the dedicated shared subagent window. The
 *   orchestrator's window is never split or resized, so zoom (prefix z) and
 *   pane focus stay exactly as the user left them; the subagent window is
 *   one glance away via the tmux window list.
 * - "pane": legacy behaviour — a right split off the parent pi pane.
 */
function panePlacement(): "window" | "pane" {
  return process.env.PI_SUBAGENT_PLACEMENT === "pane" ? "pane" : "window";
}

let rebalanceTimer: ReturnType<typeof setTimeout> | null = null;

/** Cached id of the shared subagent window, once created or found. */
let subagentWindowId: string | null = null;

/**
 * Re-balance subagent panes so repeated splits don't leave them lopsided.
 * tmux halves the target pane on every split and dumps freed space onto a
 * neighbor on close, so without this panes drift to wildly uneven widths.
 * Applies SUBAGENT_TMUX_LAYOUT to the shared subagent window — never to the
 * orchestrator's window, which must not be resized. Debounced so a burst
 * of parallel spawns or staggered exits collapses into a single layout call,
 * and non-fatal: a cosmetic resize must never break spawning or watching.
 */
function rebalanceSurfaces(hintPane?: string): void {
  if (panePlacement() === "pane") {
    // Legacy placement: balance the parent pi's window (stable; survives a
    // closing subagent pane).
    scheduleRebalance(process.env.TMUX_PANE ?? hintPane);
    return;
  }
  // Window placement: balance only the subagent window. Prefer the cached
  // window id; fall back to the hint pane's window (hints are always
  // subagent panes here, so this resolves to the shared window).
  scheduleRebalance(subagentWindowId ?? (hintPane ? windowOfPane(hintPane) : null));
}

function scheduleRebalance(target: string | null | undefined): void {
  if (!target) return;
  if (rebalanceTimer) clearTimeout(rebalanceTimer);
  rebalanceTimer = setTimeout(() => {
    rebalanceTimer = null;
    try {
      // -t <window> resolves to that window; does not change focus.
      // stdio piped so a dead window's error stays in the catch instead of
      // leaking to this process's stderr.
      execFileSync("tmux", ["select-layout", "-t", target, SUBAGENT_TMUX_LAYOUT], {
        encoding: "utf8",
        stdio: "pipe",
      });
    } catch {
      // Pane/window may be gone; balancing is best-effort.
    }
  }, 120);
}

// ── Shared subagent window ──

/**
 * Find the shared subagent window in the current tmux session, if one
 * exists. Matched by window name, or by the `@pi-subagents` window marker
 * (which holds the name the window was created with, so it survives manual
 * renames but not a changed PI_SUBAGENT_WINDOW_NAME). Returns the window id
 * (e.g. `@3`) or null.
 */
function findSubagentWindow(): string | null {
  try {
    const out = execFileSync(
      "tmux",
      ["list-windows", "-F", "#{window_id}\t#{@pi-subagents}\t#{window_name}"],
      { encoding: "utf8", stdio: "pipe" },
    );
    const wanted = subagentWindowName();
    for (const line of out.split("\n")) {
      const [id, marker, ...rest] = line.trim().split("\t");
      if (!id?.startsWith("@")) continue;
      if (marker === wanted || rest.join("\t") === wanted) return id;
    }
  } catch {
    // No server / no windows — treated as "not found".
  }
  return null;
}

/**
 * Create the shared subagent window. `-d` keeps the client's current window
 * selected, so focus does not move. Marks the window with `@pi-subagents`
 * and turns on titled pane borders so panes are identifiable at a glance.
 * Returns the new window id.
 */
function createSubagentWindow(): string {
  const id = execFileSync(
    "tmux",
    ["new-window", "-d", "-n", subagentWindowName(), "-P", "-F", "#{window_id}"],
    { encoding: "utf8", stdio: "pipe" },
  ).trim();
  if (!id.startsWith("@")) {
    throw new Error(`Unexpected tmux new-window output: ${id}`);
  }
  try {
    // Marker for reliable lookup even if the window is renamed later.
    execFileSync("tmux", ["set-window-option", "-t", id, "@pi-subagents", subagentWindowName()], {
      encoding: "utf8",
      stdio: "pipe",
    });
    // Show the pane title (the subagent's name) on a border line.
    execFileSync("tmux", ["set-window-option", "-t", id, "pane-border-status", "top"], {
      encoding: "utf8",
      stdio: "pipe",
    });
    execFileSync(
      "tmux",
      ["set-window-option", "-t", id, "pane-border-format", "#{pane_index}: #{pane_title}"],
      { encoding: "utf8", stdio: "pipe" },
    );
  } catch {
    // Cosmetic only — the window still works without borders or marker.
  }
  return id;
}

/** First pane id of a window, or null if the window is gone. */
function firstPaneOfWindow(windowId: string): string | null {
  try {
    const out = execFileSync("tmux", ["list-panes", "-t", windowId, "-F", "#{pane_id}"], {
      encoding: "utf8",
      stdio: "pipe",
    });
    const first = out.split("\n").find((line) => line.trim().startsWith("%"));
    return first?.trim() ?? null;
  } catch {
    return null;
  }
}

/** The window id containing a pane, or null if the pane is gone. */
function windowOfPane(paneId: string): string | null {
  try {
    const win = execFileSync("tmux", ["display-message", "-p", "-t", paneId, "#{window_id}"], {
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
    return win.startsWith("@") ? win : null;
  } catch {
    return null;
  }
}

// ── Surface primitives ──

/**
 * Create a new pane for a subagent.
 *
 * Default ("window" placement): the pane is created inside the dedicated
 * shared subagent window — created detached on first spawn, reused
 * afterwards. The orchestrator's window is never split or resized, so zoom
 * (prefix z) and focus stay as the user left them; the subagent window is
 * one glance away via the tmux window list. The pane's title is set to the
 * subagent's name and shown on the pane border.
 *
 * Legacy ("pane" placement, `PI_SUBAGENT_PLACEMENT=pane`): a right split off
 * the parent pi's pane, so new panes follow the agent rather than the user's
 * focus. See https://github.com/HazAT/pi-interactive-subagents/issues/12
 *
 * Returns the new pane id (e.g. `%12`).
 */
export function createSurface(name: string): string {
  if (panePlacement() === "pane") {
    return createSurfaceSplit(name, "right", process.env.TMUX_PANE);
  }
  return createSurfaceInSubagentWindow(name);
}

function createSurfaceInSubagentWindow(name: string): string {
  requireTmux();

  const existing = findSubagentWindow();
  const windowId = existing ?? createSubagentWindow();
  subagentWindowId = windowId;

  let pane: string;
  if (existing) {
    // Split the window's first pane; rebalancing evens the layout out.
    const anchor = firstPaneOfWindow(windowId);
    if (!anchor) throw new Error(`Subagent window ${windowId} has no panes`);
    pane = execFileSync(
      "tmux",
      ["split-window", "-d", "-h", "-t", anchor, "-P", "-F", "#{pane_id}"],
      { encoding: "utf8", stdio: "pipe" },
    ).trim();
  } else {
    // A fresh window already has one pane running the default shell — adopt
    // it as the subagent's pane instead of leaving an idle shell behind.
    pane = firstPaneOfWindow(windowId) ?? "";
  }
  if (!pane.startsWith("%")) {
    throw new Error(`Unexpected tmux pane id: ${pane}`);
  }

  // Name the pane (shown on the border) so panes are identifiable at a glance.
  try {
    execFileSync("tmux", ["select-pane", "-t", pane, "-T", name], {
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch {
    // Cosmetic only.
  }

  rebalanceSurfaces(pane);
  return pane;
}

/**
 * Create a new split in the given direction from an optional source pane.
 * Low-level primitive: the split always lands in the source pane's window
 * (or the parent pi's window when no source is given), i.e. legacy
 * placement — `createSurface` is the real entry point and honors
 * PI_SUBAGENT_PLACEMENT. Returns the new pane id (e.g. `%12`).
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  void name;
  requireTmux();

  const args = ["split-window", "-d"];
  if (direction === "left" || direction === "right") {
    args.push("-h");
  } else {
    args.push("-v");
  }
  if (direction === "left" || direction === "up") {
    args.push("-b");
  }
  if (fromSurface) {
    args.push("-t", fromSurface);
  }
  args.push("-P", "-F", "#{pane_id}");

  const pane = execFileSync("tmux", args, { encoding: "utf8" }).trim();
  if (!pane.startsWith("%")) {
    throw new Error(`Unexpected tmux split-window output: ${pane}`);
  }

  rebalanceSurfaces(pane);
  return pane;
}

/**
 * Send a command string to a pane and execute it.
 * Typed literally (`-l`) so special characters are not interpreted as keys,
 * then submitted with Enter.
 */
export function sendCommand(surface: string, command: string): void {
  requireTmux();
  execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], { encoding: "utf8" });
  execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], { encoding: "utf8" });
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * This avoids terminal line-wrapping issues that break commands exceeding the
 * pane's column width when sent character-by-character via sendCommand.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    mode: 0o755,
  });
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

/**
 * Read the screen contents of a pane (sync).
 */
export function readScreen(surface: string, lines = 50): string {
  requireTmux();
  return execFileSync(
    "tmux",
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    {
      encoding: "utf8",
    },
  );
}

/**
 * Read the screen contents of a pane (async).
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireTmux();
  const { stdout } = await execFileAsync(
    "tmux",
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    { encoding: "utf8" },
  );
  return stdout;
}

/**
 * Close a pane.
 */
export function closeSurface(surface: string): void {
  requireTmux();
  execFileSync("tmux", ["kill-pane", "-t", surface], { encoding: "utf8" });
  rebalanceSurfaces();
}

// ── Exit polling ──

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "sentinel" | "error";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
}

/**
 * Interpret an `.exit` sidecar payload (written by the error path in
 * subagent-done.ts). Centralized so both the fast and slow paths in
 * pollForExit decode the payload the same way. Clean completions write no
 * sidecar and are detected via the terminal sentinel instead.
 *
 * Note: ask_question does NOT write a `.exit` sidecar — it keeps the session
 * open and signals the parent via a separate `.ask` file (see deliverPendingQuestion).
 */
function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar };

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by the error path), falling back to the terminal sentinel for
 * clean-completion and crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file (written by the error path)
    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf-8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    // Check Claude sentinel file (written by plugin Stop hook)
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {}
    }

    // Slow path: read terminal screen for sentinel (crash detection)
    try {
      const screen = await readScreenAsync(surface, 5);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
    } catch {
      // Surface may have been destroyed — check if .exit file appeared in the meantime
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf-8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
