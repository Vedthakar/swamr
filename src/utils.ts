import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const isTTY = process.stdout.isTTY ?? false;

const GREEN = isTTY ? "\x1b[0;32m" : "";
const YELLOW = isTTY ? "\x1b[1;33m" : "";
const CYAN = isTTY ? "\x1b[0;36m" : "";
const BOLD = isTTY ? "\x1b[1m" : "";
const RESET = isTTY ? "\x1b[0m" : "";

export function info(msg: string) {
  console.log(`${GREEN}[✓]${RESET} ${msg}`);
}

export function warn(msg: string) {
  console.log(`${YELLOW}[!]${RESET} ${msg}`);
}

export function header(msg: string) {
  console.log(`\n${BOLD}${CYAN}${msg}${RESET}`);
}

export function bold(msg: string): string {
  return `${BOLD}${msg}${RESET}`;
}

export function run(cmd: string, cwd?: string): string {
  return execSync(cmd, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

export function runSafe(cmd: string, cwd?: string): string | null {
  try {
    return run(cmd, cwd);
  } catch {
    return null;
  }
}

export function writeFileDeep(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

export function copyDirRecursive(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

export function commandExists(cmd: string): boolean {
  return runSafe(`which ${cmd}`) !== null;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const SPINNER_MESSAGES = [
  "herding agents into formation",
  "bribing the planner with tokens",
  "teaching bees to code",
  "untangling dependency spaghetti",
  "convincing typescript this is fine",
  "asking politely for no bugs",
  "warming up the hive mind",
  "negotiating with node_modules",
  "summoning 150 tiny engineers",
  "polishing the architecture",
  "whispering to the compiler",
  "counting semicolons nervously",
  "rehearsing error messages",
  "alphabetizing the chaos",
  "calibrating the swarm",
  "consulting the obsidian oracle",
  "drafting a strongly-worded commit",
  "shaking hands with supabase",
  "triple-checking the vibes",
  "feeding the agents coffee",
  "deploying thoughts and prayers",
  "asking claude for a second opinion",
  "translating requirements to english",
  "spinning up parallel universes",
  "defragmenting the plan",
  "crossing fingers in production",
  "stacking contexts carefully",
  "poking the build system",
  "optimizing for good energy",
  "generating plausible excuses",
  "charging the flux capacitor",
  "wrangling rogue promises",
  "putting the fun in functions",
  "aligning the tech stack chakras",
  "reticulating splines",
  "compiling hopes and dreams",
  "shuffling the task deck",
  "making the tests believe in themselves",
  "downloading more ram",
  "reading the room temperature",
];

function cols(): number {
  return process.stdout.columns ?? 80;
}

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen - 1) + "…" : text;
}

function progressBar(filled: number, total: number, width: number): string {
  const pct = total > 0 ? filled / total : 0;
  const blocks = Math.round(pct * width);
  return "█".repeat(blocks) + "░".repeat(width - blocks);
}

export class Spinner {
  private interval: ReturnType<typeof setInterval> | null = null;
  private frameIndex = 0;
  private messageIndex: number;

  constructor() {
    this.messageIndex = Math.floor(Math.random() * SPINNER_MESSAGES.length);
  }

  start(label?: string) {
    if (!isTTY) {
      if (label) console.log(label);
      return;
    }
    this.frameIndex = 0;
    let ticks = 0;
    this.interval = setInterval(() => {
      const frame = SPINNER_FRAMES[this.frameIndex % SPINNER_FRAMES.length];
      const msg = SPINNER_MESSAGES[this.messageIndex % SPINNER_MESSAGES.length];
      const suffix = label ? `${label} — ${msg}` : msg;
      // Truncate to terminal width so it never wraps
      const line = truncate(`${frame} ${suffix}`, cols() - 1);
      process.stdout.write(`\r${CYAN}${line}${RESET}\x1b[K`);
      this.frameIndex++;
      ticks++;
      if (ticks % 25 === 0) {
        this.messageIndex = (this.messageIndex + 1 + Math.floor(Math.random() * 3)) % SPINNER_MESSAGES.length;
      }
    }, 80);
  }

  stop(finalMessage?: string) {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (isTTY) {
      process.stdout.write("\r\x1b[K");
    }
    if (finalMessage) {
      info(finalMessage);
    }
  }
}

// ─── Multi-task progress dashboard ───────────────────────────────────────────
// Renders a fixed block of lines and rewrites them in place on each tick.

export interface ProgressTask {
  id: string;
  description: string;
}

export class ProgressDashboard {
  private interval: ReturnType<typeof setInterval> | null = null;
  private frameIndex = 0;
  private messageIndex = 0;
  private renderedLines = 0;

  // mutable state updated from outside
  phase = "";
  phaseIndex = 0;
  totalPhases = 0;
  phaseCompleted = 0;
  phaseTotal = 0;
  overallCompleted = 0;
  overallTotal = 0;
  activeTasks: ProgressTask[] = [];
  wave = 0;
  checkpoint = false;
  blockedCount = 0;

  start() {
    if (!isTTY) return;
    this.messageIndex = Math.floor(Math.random() * SPINNER_MESSAGES.length);
    this.interval = setInterval(() => this.render(), 100);
  }

  private render() {
    const w = cols();
    const frame = SPINNER_FRAMES[this.frameIndex % SPINNER_FRAMES.length];
    const quip = SPINNER_MESSAGES[this.messageIndex % SPINNER_MESSAGES.length];

    // Move cursor up to overwrite previous render
    if (this.renderedLines > 0) {
      process.stdout.write(`\x1b[${this.renderedLines}A`);
    }

    const lines: string[] = [];

    // ── Row 1: overall bar ──────────────────────────────────────────────────
    const overallPct = this.overallTotal > 0
      ? Math.round((this.overallCompleted / this.overallTotal) * 100)
      : 0;
    const barWidth = Math.max(10, Math.min(28, w - 52));
    const bar = progressBar(this.overallCompleted, this.overallTotal, barWidth);
    const overallLabel = `${BOLD}[${bar}]${RESET} ${String(overallPct).padStart(3)}%  overall ${this.overallCompleted}/${this.overallTotal} tasks`;
    lines.push(truncate(overallLabel, w));

    // ── Row 2: phase bar ────────────────────────────────────────────────────
    const phasePct = this.phaseTotal > 0
      ? Math.round((this.phaseCompleted / this.phaseTotal) * 100)
      : 0;
    const phaseBar = progressBar(this.phaseCompleted, this.phaseTotal, barWidth);
    const waveTag = this.wave > 0 ? `  wave ${this.wave}${this.checkpoint ? " · checkpoint" : ""}` : "";
    const phaseLabel = `${CYAN}[${phaseBar}]${RESET} ${String(phasePct).padStart(3)}%  phase ${this.phaseIndex}/${this.totalPhases}: ${this.phase.toUpperCase()} ${this.phaseCompleted}/${this.phaseTotal}${waveTag}`;
    lines.push(truncate(phaseLabel, w));

    // ── Row 3: quip / checkpoint ────────────────────────────────────────────
    const status = this.checkpoint ? "re-evaluating progress (checkpoint agent)" : quip;
    lines.push(truncate(`${CYAN}${frame}${RESET} ${status}`, w));

    // ── Row 4: blocked / NEEDS YOU (always present so height stays stable) ───
    lines.push(
      this.blockedCount > 0
        ? truncate(`${YELLOW}🙋 ${this.blockedCount} task(s) need you — see swamr/NEEDS-YOU.md${RESET}`, w)
        : ""
    );

    // ── Rows 5+: active tasks (up to 6) ────────────────────────────────────
    lines.push("");
    const shown = this.activeTasks.slice(0, 6);
    for (const t of shown) {
      lines.push(truncate(`  ${CYAN}${frame}${RESET} [${t.id}] ${t.description}`, w));
    }
    // pad to always have 6 task rows so height stays stable
    for (let i = shown.length; i < 6; i++) {
      lines.push("");
    }

    for (const line of lines) {
      process.stdout.write(line + "\x1b[K\n");
    }
    this.renderedLines = lines.length;

    this.frameIndex++;
    if (this.frameIndex % 20 === 0) {
      this.messageIndex = (this.messageIndex + 1 + Math.floor(Math.random() * 3)) % SPINNER_MESSAGES.length;
    }
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    // Clear the dashboard block
    if (isTTY && this.renderedLines > 0) {
      process.stdout.write(`\x1b[${this.renderedLines}A`);
      for (let i = 0; i < this.renderedLines; i++) {
        process.stdout.write("\x1b[K\n");
      }
      process.stdout.write(`\x1b[${this.renderedLines}A`);
      this.renderedLines = 0;
    }
  }
}
