import fs from "node:fs";
import path from "node:path";
import { spawn, ChildProcess } from "node:child_process";
import { info, warn, header, bold, writeFileDeep, runSafe, Spinner, ProgressDashboard, ProgressTask } from "./utils.js";
import { initBrain } from "./brain.js";

interface TaskDef {
  id: string;
  phase: string;
  description: string;
  agent: string;
  prompt: string;
  depends_on: string[];
  status: "pending" | "in_progress" | "completed" | "failed" | "blocked" | "skipped";
  attempts: number;
  output?: string;
  blocked_by?: string[];
}

interface CheckpointMeta {
  phase: string;
  wave: number;
  at: string;
}

interface SwamrState {
  project: string;
  status: string;
  current_phase: string;
  started_at: string;
  tasks: TaskDef[];
  phase_waves?: Record<string, number>;
  last_checkpoint?: CheckpointMeta | null;
  checkpoint_pending?: boolean;
}

interface SwamrConfig {
  max_parallel_agents: number;
  // Hard cap on agents spawned simultaneously in a single wave. Decoupled from
  // wave_size so "150 total agents" can run across waves without 150 at once.
  max_concurrent_agents: number;
  max_retries_per_task: number;
  wave_size: number;
  verify_wave_size: number;
  checkpoint_between_waves: boolean;
  required_mcps: string[] | null;
  // Target number of build tasks the planner should produce.
  min_build_tasks: number;
  // How many domain sub-planners the hierarchical planner fans out to.
  domain_planners: number;
}

interface Blocker {
  task_id: string;
  title: string;
  what_i_need: string;
  why?: string;
  steps?: string[];
  automated_check?: string;
}

// Phases where we run smaller waves and force a deep verification checkpoint between them.
const VERIFY_PHASES = new Set(["testing", "security", "legal"]);

// Full lifecycle: build -> full E2E testing -> security hardening -> legal
// compliance -> launch/handoff.
const BUILD_PHASES = ["foundation", "build", "testing", "security", "legal", "launch"] as const;

const PHASE_BRAIN_DIRS: Record<string, string> = {
  foundation: "02-foundation",
  build: "03-build",
  testing: "04-testing",
  security: "05-security",
  legal: "05-legal",
  launch: "06-launch",
};

function phaseBrainDir(phase: string): string {
  return PHASE_BRAIN_DIRS[phase] ?? `99-${phase}`;
}

function ensureStateDefaults(state: SwamrState): void {
  if (!state.phase_waves) state.phase_waves = {};
  if (state.last_checkpoint === undefined) state.last_checkpoint = null;
  if (state.checkpoint_pending === undefined) state.checkpoint_pending = false;
}

function getActivePhase(state: SwamrState): string | null {
  for (const phase of BUILD_PHASES) {
    const phaseTasks = state.tasks.filter((t) => t.phase === phase);
    if (phaseTasks.length === 0) continue;
    if (!phaseTasks.every((t) => t.status === "completed")) return phase;
  }
  return null;
}

function checkpointFileName(phase: string, wave: number): string {
  return `${phase}-wave-${wave}.md`;
}

function checkpointFilePath(projectDir: string, phase: string, wave: number): string {
  return path.join(
    projectDir,
    "swamr",
    "brain",
    "03-build",
    "checkpoints",
    checkpointFileName(phase, wave)
  );
}

function latestCheckpointForPhase(
  projectDir: string,
  phase: string
): { wave: number; content: string; fileName: string } | null {
  const checkpointsDir = path.join(projectDir, "swamr", "brain", "03-build", "checkpoints");
  if (!fs.existsSync(checkpointsDir)) return null;

  const prefix = `${phase}-wave-`;
  let best: { wave: number; content: string; fileName: string } | null = null;

  for (const name of fs.readdirSync(checkpointsDir)) {
    if (!name.endsWith(".md")) continue;
    if (name.startsWith(prefix)) {
      const wave = parseInt(name.slice(prefix.length, -3), 10);
      if (Number.isNaN(wave)) continue;
      if (!best || wave > best.wave) {
        best = {
          wave,
          content: fs.readFileSync(path.join(checkpointsDir, name), "utf-8"),
          fileName: name,
        };
      }
    }
  }

  if (!best && phase === "foundation") {
    const legacy = path.join(checkpointsDir, "wave-1.md");
    if (fs.existsSync(legacy)) {
      best = {
        wave: 1,
        content: fs.readFileSync(legacy, "utf-8"),
        fileName: "wave-1.md",
      };
    }
  }

  return best;
}

// Output patterns that signal an agent is stuck on something only a human can do.
const MANUAL_STEP_PATTERNS: RegExp[] = [
  /needs approval/i,
  /not authenticated/i,
  /requires? (?:an? )?api[ _-]?key/i,
  /supabase login/i,
  /supabase link/i,
  /create (?:a )?(?:new )?project/i,
  /\bdashboard\b/i,
  /sign ?up/i,
  /create an account/i,
  /\bcredentials?\b/i,
  /\bbilling\b/i,
  /\bbrowser\b/i,
  /cannot .*headless/i,
  /\bmcp\b[^.\n]*\b(login|auth)/i,
  /please (?:authenticate|log ?in|sign ?in|approve)/i,
  /awaiting (?:user|human|manual)/i,
  /usage limit/i,
  /spend limit/i,
];

function loadConfig(projectDir: string): SwamrConfig {
  const configPath = path.join(projectDir, "swamr", "config.json");
  let raw: any = {};
  if (fs.existsSync(configPath)) {
    raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  }
  const maxParallel = raw.max_parallel_agents ?? 20;
  const maxConcurrent = raw.max_concurrent_agents ?? maxParallel;
  return {
    max_parallel_agents: maxParallel,
    max_concurrent_agents: maxConcurrent,
    max_retries_per_task: raw.max_retries_per_task ?? 3,
    wave_size: Math.min(raw.wave_size ?? 20, maxConcurrent),
    verify_wave_size: Math.min(raw.verify_wave_size ?? 8, maxConcurrent),
    checkpoint_between_waves: raw.checkpoint_between_waves ?? true,
    required_mcps: Array.isArray(raw.required_mcps) ? raw.required_mcps : null,
    min_build_tasks: raw.min_build_tasks ?? 150,
    domain_planners: raw.domain_planners ?? 12,
  };
}

function loadState(projectDir: string): SwamrState | null {
  const statePath = path.join(projectDir, "swamr", "state.json");
  if (fs.existsSync(statePath)) {
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as SwamrState;
    ensureStateDefaults(state);
    return state;
  }
  return null;
}

function saveState(projectDir: string, state: SwamrState) {
  writeFileDeep(
    path.join(projectDir, "swamr", "state.json"),
    JSON.stringify(state, null, 2)
  );
}

// ─── MCP preflight ────────────────────────────────────────────────────────────
// Headless `cursor agent --print` cannot complete an interactive MCP auth/approval
// in the Cursor GUI — it just silently waits until timeout (the F2 Supabase hang).
// Detect that BEFORE spawning the swarm and tell the user exactly what to do.

const MCP_NOT_READY = /not authenticated|unauthor/i;

function preflightMcp(
  projectDir: string,
  config: SwamrConfig
): { ok: boolean; notReady: { name: string; status: string }[] } {
  const out = runSafe("cursor agent mcp list", projectDir);
  // If we can't determine status, don't block the build.
  if (out === null) return { ok: true, notReady: [] };

  const servers = out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf(":");
      if (i === -1) return null;
      return { name: l.slice(0, i).trim(), status: l.slice(i + 1).trim() };
    })
    .filter((s): s is { name: string; status: string } => !!s && !!s.name);

  if (servers.length === 0) return { ok: true, notReady: [] };

  const required =
    config.required_mcps && config.required_mcps.length > 0
      ? config.required_mcps
      : servers.map((s) => s.name);

  const notReady = servers.filter(
    (s) => required.includes(s.name) && MCP_NOT_READY.test(s.status)
  );
  return { ok: notReady.length === 0, notReady };
}

// ─── Manual-step / blocker handoff ──────────────────────────────────────────────

function blockersDir(projectDir: string): string {
  return path.join(projectDir, "swamr", "blockers");
}

function parseBlockerFile(filePath: string, taskId: string): Blocker | null {
  try {
    const b = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (b.task_id && b.task_id !== taskId) return null;
    return { task_id: taskId, title: b.title ?? taskId, ...b };
  } catch {
    return null;
  }
}

function readBlocker(projectDir: string, taskId: string): Blocker | null {
  const fp = path.join(blockersDir(projectDir), `${taskId}.json`);
  if (fs.existsSync(fp)) {
    const blocker = parseBlockerFile(fp, taskId);
    if (blocker) return blocker;
  }

  // Fallback: agents sometimes write descriptive filenames (e.g. F4c-oauth.json for task F4e).
  const dir = blockersDir(projectDir);
  if (!fs.existsSync(dir)) return null;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json") || name === `${taskId}.json`) continue;
    const blocker = parseBlockerFile(path.join(dir, name), taskId);
    if (blocker) return blocker;
  }
  return null;
}

function writeBlocker(projectDir: string, blocker: Blocker) {
  writeFileDeep(
    path.join(blockersDir(projectDir), `${blocker.task_id}.json`),
    JSON.stringify(blocker, null, 2)
  );
}

function clearBlocker(projectDir: string, taskId: string) {
  const dir = blockersDir(projectDir);
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const fp = path.join(dir, name);
    if (name === `${taskId}.json`) {
      fs.rmSync(fp);
      continue;
    }
    try {
      const b = JSON.parse(fs.readFileSync(fp, "utf-8"));
      if (b.task_id === taskId) fs.rmSync(fp);
    } catch {
      /* ignore malformed blocker files */
    }
  }
}

/** Parse verify commands from blocker steps or automated_check field. */
function extractVerifyCommand(blocker: Blocker): string | null {
  if (blocker.automated_check?.trim()) return blocker.automated_check.trim();
  if (!blocker.steps) return null;
  for (const step of blocker.steps) {
    const verifyMatch = step.match(/Verify:\s*run\s+(.+)/i);
    if (verifyMatch) return verifyMatch[1].trim();
    const runMatch = step.match(/^Run\s+(npm run\s+\S+)/i);
    if (runMatch) return runMatch[1].trim();
  }
  return null;
}

/** Decide whether a verify command's output means the blocker is resolved. */
function isBlockerResolved(blocker: Blocker, output: string): boolean {
  if (/❌|Provider not enabled|not enabled in Supabase/i.test(output)) return false;

  switch (blocker.task_id) {
    case "F4c":
    case "F4e":
      return (
        /OAuth providers appear configured/i.test(output) ||
        (/✅ google:/i.test(output) &&
          /✅ apple:/i.test(output) &&
          !/⚠️\s+(google|apple):/i.test(output))
      );
    default:
      return (
        (/✅|passed|success|appear configured/i.test(output) ||
          !/failed|error|blocked/i.test(output)) &&
        !/❌/.test(output)
      );
  }
}

/**
 * Run verify commands from blocker steps. On success, clear the blocker and
 * mark the task completed (manual setup tasks don't need another agent pass).
 */
function autoVerifyBlockers(
  projectDir: string,
  state: SwamrState,
  userMessage?: string
): number {
  let cleared = 0;

  for (const task of state.tasks) {
    if (task.status !== "blocked") continue;
    const blocker = readBlocker(projectDir, task.id);
    if (!blocker) continue;

    const verifyCmd = extractVerifyCommand(blocker);
    let output: string | null = null;
    let resolved = false;

    if (verifyCmd) {
      info(`Auto-verifying [${task.id}]: ${verifyCmd}`);
      output = runSafe(verifyCmd, projectDir);
      if (output !== null && isBlockerResolved(blocker, output)) {
        resolved = true;
      }
    }

    if (
      !resolved &&
      userMessage &&
      /configured|enabled|done|fixed|completed|added|resolved/i.test(userMessage)
    ) {
      if (verifyCmd) {
        output = output ?? runSafe(verifyCmd, projectDir);
        if (output !== null && isBlockerResolved(blocker, output)) {
          resolved = true;
        }
      } else if (
        new RegExp(task.id, "i").test(userMessage) ||
        new RegExp(blocker.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(userMessage)
      ) {
        resolved = true;
      }
    }

    if (resolved) {
      clearBlocker(projectDir, task.id);
      task.status = "completed";
      task.blocked_by = undefined;
      cleared++;
      info(`Blocker [${task.id}] resolved — task marked complete`);

      writeFileDeep(
        path.join(projectDir, "swamr", "brain", "03-build", "task-outputs", `${task.id}.md`),
        `---
task_id: ${task.id}
status: completed
verified: auto
date: ${new Date().toISOString()}
---

# ${blocker.title}

## Auto-verified on continue
Manual step confirmed via verify command${userMessage ? " and user message" : ""}.

${userMessage ? `## User message\n${userMessage}\n` : ""}
${output ? `## Verify output\n\`\`\`\n${output.slice(-8000)}\n\`\`\`` : ""}
`
      );
      appendPhaseLog(projectDir, `- ${task.id}: auto-verified (blocker cleared)`);
    }
  }

  if (cleared > 0) saveState(projectDir, state);
  return cleared;
}

function writeUserContext(projectDir: string, message: string) {
  const fp = path.join(projectDir, "swamr", "brain", "03-build", "user-context.md");
  const entry = `\n## ${new Date().toISOString()}\n${message.trim()}\n`;
  const existing = fs.existsSync(fp) ? fs.readFileSync(fp, "utf-8") : "# User context\n\nMessages from `swamr continue -m` — read before starting any task.\n";
  writeFileDeep(fp, existing + entry);
}

function appendPhaseLog(projectDir: string, line: string) {
  const fp = path.join(projectDir, "swamr", "brain", "03-build", "phase-log.md");
  const header = "# Phase log\n\nOne-line entries as tasks complete.\n\n";
  const existing = fs.existsSync(fp) ? fs.readFileSync(fp, "utf-8") : header;
  writeFileDeep(fp, existing + line + "\n");
}

/** Expo/NativeWind runtime checks — catches Metro/babel failures before agents claim success. */
function runProjectPreflight(projectDir: string): string[] {
  const issues: string[] = [];
  const pkgPath = path.join(projectDir, "package.json");
  if (!fs.existsSync(pkgPath)) return issues;

  let pkg: any;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  } catch {
    return issues;
  }

  const isExpo = pkg.dependencies?.expo || pkg.devDependencies?.expo;
  if (isExpo) {
    const babelPath = path.join(projectDir, "babel.config.js");
    if (fs.existsSync(babelPath)) {
      const babel = fs.readFileSync(babelPath, "utf-8");
      if (/nativewind/i.test(babel)) {
        const ok = runSafe("node -e \"require('react-native-worklets/plugin')\"", projectDir);
        if (ok === null) {
          issues.push(
            "Missing react-native-worklets (NativeWind/babel). Fix: npx expo install react-native-worklets"
          );
        }
      }
    }
  }

  if (pkg.scripts?.["type-check"]) {
    const tc = runSafe("npm run type-check", projectDir);
    if (tc === null) {
      issues.push("Type check failed — run npm run type-check and fix errors before device testing");
    }
  }

  if (issues.length > 0) {
    const fp = path.join(projectDir, "swamr", "brain", "03-build", "issues", "runtime-preflight.md");
    writeFileDeep(
      fp,
      `---
updated: ${new Date().toISOString()}
---

# Runtime preflight issues

These were detected automatically — fix before simulator/device testing.

${issues.map((i) => `- ${i}`).join("\n")}
`
    );
  }

  return issues;
}

// Infer a blocker from agent output when the worker didn't write one itself.
function detectManualStep(output: string, task: TaskDef): Blocker | null {
  if (!MANUAL_STEP_PATTERNS.some((re) => re.test(output))) return null;
  if (/usage limit|spend limit/i.test(output)) {
    return {
      task_id: task.id,
      title: `${task.description} (model usage limit reached)`,
      what_i_need:
        "Cursor model usage limit was reached for this worker model, so the task cannot run until the model is changed or quota resets.",
      why: "The worker output reports model usage/spend limit exhaustion.",
      steps: [
        "Retry with an available model: swamr continue --model auto",
        "Or pick a specific model: swamr continue --model gpt-5.3-codex-high",
        "If needed, increase spend/quota limits in Cursor account settings",
      ],
    };
  }
  return {
    task_id: task.id,
    title: task.description,
    what_i_need:
      "A manual step (auth, API key, account, or GUI action) appears to be required.",
    why: "The agent's output indicates it is waiting on something only you can do.",
    steps: [
      "If an MCP server needs auth, run: cursor agent mcp login <server>",
      "If an API key/secret is needed, add it to .env.local",
      "Then re-run: swamr continue",
    ],
  };
}

function collectBlockers(projectDir: string, state: SwamrState): Blocker[] {
  return state.tasks
    .filter((t) => t.status === "blocked")
    .map((t) => readBlocker(projectDir, t.id))
    .filter((b): b is Blocker => b !== null);
}

function writeNeedsYou(projectDir: string, blockers: Blocker[]) {
  const fp = path.join(projectDir, "swamr", "NEEDS-YOU.md");
  if (blockers.length === 0) {
    if (fs.existsSync(fp)) fs.rmSync(fp);
    return;
  }
  const body = blockers
    .map((b) => {
      const steps = (b.steps ?? []).map((s) => `   - ${s}`).join("\n");
      return `## [${b.task_id}] ${b.title}

**What I need from you:** ${b.what_i_need}
${b.why ? `\n**Why:** ${b.why}\n` : ""}${steps ? `\n**How to resolve:**\n${steps}\n` : ""}`;
    })
    .join("\n");
  writeFileDeep(
    fp,
    `# 🙋 Swamr needs you

These tasks are paused waiting on a manual step only you can do. Resolve them, then run \`swamr continue\`.

${body}
`
  );
}

function printNeedsYou(blockers: Blocker[]) {
  if (blockers.length === 0) return;
  header(`🙋 NEEDS YOU — ${blockers.length} task(s) waiting on a manual step`);
  for (const b of blockers) {
    console.log(`\n  ${bold(`[${b.task_id}] ${b.title}`)}`);
    console.log(`  → ${b.what_i_need}`);
    for (const s of b.steps ?? []) console.log(`     • ${s}`);
  }
  console.log(`\n  Details written to swamr/NEEDS-YOU.md`);
  console.log(`  After resolving, run: swamr continue`);
  console.log(`  Or with context: swamr continue -m "what you changed"\n`);
}

function findBlockingDeps(task: TaskDef, state: SwamrState, seen = new Set<string>()): string[] {
  const blockers = new Set<string>();
  for (const dep of task.depends_on) {
    if (seen.has(dep)) continue;
    seen.add(dep);
    const depTask = state.tasks.find((t) => t.id === dep);
    if (!depTask) continue;
    if (depTask.status === "failed" || depTask.status === "blocked" || depTask.status === "skipped") {
      blockers.add(depTask.id);
      for (const nested of depTask.blocked_by ?? []) blockers.add(nested);
      continue;
    }
    for (const nested of findBlockingDeps(depTask, state, seen)) blockers.add(nested);
  }
  return [...blockers];
}

function markUnreachable(projectDir: string, tasks: TaskDef[], state: SwamrState): number {
  let skipped = 0;
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) {
      if (task.status !== "pending") continue;
      const blockers = findBlockingDeps(task, state);
      if (blockers.length === 0) continue;
      task.status = "skipped";
      task.blocked_by = blockers;
      skipped++;
      changed = true;
    }
  }
  if (skipped > 0) saveState(projectDir, state);
  return skipped;
}

function buildBrainContext(projectDir: string, task?: TaskDef, phase?: string): string {
  const brainDir = path.join(projectDir, "swamr", "brain");
  const activePhase = phase ?? task?.phase;

  const files = [
    "00-project/overview.md",
    "00-project/architecture.md",
    "00-project/tech-stack.md",
    "03-build/user-context.md",
    "03-build/phase-log.md",
  ];
  let context = "";
  for (const f of files) {
    const fp = path.join(brainDir, f);
    if (fs.existsSync(fp)) {
      context += `\n--- ${f} ---\n${fs.readFileSync(fp, "utf-8").slice(0, 6000)}\n`;
    }
  }

  if (activePhase) {
    const latest = latestCheckpointForPhase(projectDir, activePhase);
    if (latest) {
      context += `\n--- 03-build/checkpoints/${latest.fileName} (latest ${activePhase} checkpoint) ---\n${latest.content.slice(0, 8000)}\n`;
    }

    const phaseBrainDir = PHASE_BRAIN_DIRS[activePhase];
    if (phaseBrainDir) {
      const summaryPath = path.join(brainDir, phaseBrainDir, "phase-summary.md");
      if (fs.existsSync(summaryPath)) {
        context += `\n--- ${phaseBrainDir}/phase-summary.md ---\n${fs.readFileSync(summaryPath, "utf-8").slice(0, 4000)}\n`;
      }
    }
  }

  const issuesDir = path.join(brainDir, "03-build", "issues");
  if (fs.existsSync(issuesDir)) {
    for (const name of fs.readdirSync(issuesDir).filter((f) => f.endsWith(".md"))) {
      const fp = path.join(issuesDir, name);
      context += `\n--- 03-build/issues/${name} ---\n${fs.readFileSync(fp, "utf-8").slice(0, 3000)}\n`;
    }
  }

  if (task?.depends_on?.length) {
    for (const depId of task.depends_on) {
      const fp = path.join(brainDir, "03-build", "task-outputs", `${depId}.md`);
      if (fs.existsSync(fp)) {
        context += `\n--- dependency ${depId} (task-outputs/${depId}.md) ---\n${fs.readFileSync(fp, "utf-8").slice(0, 5000)}\n`;
      }
    }
  }

  return context;
}

function runCursorAgent(
  projectDir: string,
  prompt: string,
  model: string = "auto",
  trust: boolean = false
): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve) => {
    const args = [
      "agent",
      "--print",
      "--output-format", "text",
      "--force",
      "--sandbox", "disabled",
      "--approve-mcps",
      ...(trust ? ["--trust"] : []),
      "--workspace", projectDir,
      "--model", model,
      prompt,
    ];

    let output = "";
    let errorOutput = "";

    const child: ChildProcess = spawn("cursor", args, {
      cwd: projectDir,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      output += text;
      process.stdout.write(text);
    });

    child.stderr?.on("data", (data: Buffer) => {
      errorOutput += data.toString();
    });

    let settled = false;
    const finish = (result: { success: boolean; output: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve(result);
    };

    child.on("close", (code) => {
      finish({
        success: code === 0,
        output: output || errorOutput,
      });
    });

    child.on("error", (err) => {
      finish({
        success: false,
        output: `Failed to spawn cursor agent: ${err.message}`,
      });
    });

    // 10 minute timeout per agent
    const timeoutId = setTimeout(() => {
      child.kill("SIGTERM");
      finish({
        success: false,
        output: output + "\n[TIMEOUT: agent killed after 10 minutes]",
      });
    }, 10 * 60 * 1000);
  });
}

// ─── Hierarchical planning ──────────────────────────────────────────────────
// One lead architect splits the system into domains; a sub-planner per domain
// produces its slice of tasks; a deterministic merge + integrator agent
// consolidates everything into swamr/tasks.json.

const DEFAULT_DOMAINS: { domain: string; agent: string; focus: string }[] = [
  { domain: "data-model", agent: "database-optimizer", focus: "schema, migrations, RLS, indexes, seed data" },
  { domain: "auth", agent: "backend-architect", focus: "signup, login, sessions, roles, OAuth" },
  { domain: "backend-api", agent: "backend-architect", focus: "server endpoints, business logic" },
  { domain: "frontend-ui", agent: "frontend-developer", focus: "screens, components, navigation, state" },
  { domain: "design-system", agent: "ui-designer", focus: "design tokens, base components, theming" },
  { domain: "integrations", agent: "senior-developer", focus: "third-party APIs, webhooks, background jobs" },
  { domain: "testing", agent: "evidence-collector", focus: "unit, integration, and E2E test suites" },
  { domain: "security", agent: "security-architect", focus: "authz, input validation, secrets, headers" },
];

/** Run a set of agent jobs with bounded concurrency (worker-pool). */
async function runAgentBatch(
  projectDir: string,
  jobs: { id: string; prompt: string }[],
  model: string,
  trust: boolean,
  concurrency: number
): Promise<Map<string, { success: boolean; output: string }>> {
  const results = new Map<string, { success: boolean; output: string }>();
  if (jobs.length === 0) return results;
  let next = 0;
  const limit = Math.max(1, Math.min(concurrency, jobs.length));

  async function worker(): Promise<void> {
    while (true) {
      const idx = next++;
      if (idx >= jobs.length) break;
      const job = jobs[idx];
      const r = await runCursorAgent(projectDir, job.prompt, model, trust);
      results.set(job.id, r);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

function readPlanningDomains(
  projectDir: string
): { domain: string; agent: string; focus: string }[] {
  const fp = path.join(projectDir, "swamr", "planning", "domains.json");
  if (!fs.existsSync(fp)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(fp, "utf-8"));
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((d) => d && typeof d.domain === "string" && d.domain.trim())
      .map((d) => ({
        domain: String(d.domain).trim(),
        agent: typeof d.agent === "string" && d.agent ? d.agent : "senior-developer",
        focus: typeof d.focus === "string" ? d.focus : "",
      }));
  } catch {
    return [];
  }
}

function readTasksJsonSafe(projectDir: string): any[] {
  const fp = path.join(projectDir, "swamr", "tasks.json");
  if (!fs.existsSync(fp)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(fp, "utf-8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

/** Concatenate foundation + lifecycle + per-domain task files into one list. */
function mergePlanningTaskFiles(projectDir: string): any[] {
  const dir = path.join(projectDir, "swamr", "planning", "tasks");
  if (!fs.existsSync(dir)) return [];
  const merged: any[] = [];
  const seen = new Set<string>();

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  // Foundation/lifecycle first so their canonical ids win and build tasks can depend on them.
  files.sort((a, b) => {
    const rank = (n: string) =>
      n.startsWith("_foundation") ? 0 : n.startsWith("_lifecycle") ? 1 : 2;
    return rank(a) - rank(b) || a.localeCompare(b);
  });

  for (const f of files) {
    let raw: any[];
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
    } catch {
      warn(`Skipping malformed planning file: ${f}`);
      continue;
    }
    if (!Array.isArray(raw)) continue;
    for (const t of raw) {
      if (!t || typeof t.id !== "string" || !t.id.trim()) continue;
      const id = t.id.trim();
      if (seen.has(id)) continue; // drop duplicates so depends_on references stay valid
      seen.add(id);
      merged.push({
        id,
        phase: typeof t.phase === "string" ? t.phase : "build",
        description: typeof t.description === "string" ? t.description : id,
        agent: typeof t.agent === "string" && t.agent ? t.agent : "senior-developer",
        prompt: typeof t.prompt === "string" ? t.prompt : "",
        depends_on: Array.isArray(t.depends_on)
          ? t.depends_on.filter((d: any) => typeof d === "string")
          : [],
      });
    }
  }
  return merged;
}

async function runHierarchicalPlanning(
  projectDir: string,
  description: string,
  config: SwamrConfig,
  model: string,
  trust: boolean,
  opts: { adopt?: boolean; message?: string } = {}
): Promise<any[]> {
  fs.mkdirSync(path.join(projectDir, "swamr", "planning", "tasks"), { recursive: true });

  const adoptContext = opts.adopt
    ? `\n\nThis is an EXISTING project (adopt mode). FIRST read swamr/brain/00-project/existing-state.md and swamr/brain/03-build/user-context.md. Plan ONLY the work that REMAINS to reach the goal. Do NOT recreate features that already exist and work.${opts.message ? ` The user specifically wants: ${opts.message}` : ""}`
    : "";

  // ── Stage 1: Lead architect ───────────────────────────────────────────────
  header("Planning 1/3: Lead architect (architecture + domains)");
  const leadSpinner = new Spinner();
  leadSpinner.start("Designing architecture and splitting into domains");

  const leadPrompt = `You are the Swamr Lead Architect. Read .cursor/rules/swamr-orchestrator.mdc and .cursor/rules/swamr-planner.mdc and fully adopt the @software-architect persona.

The user wants to build: ${description}${adoptContext}

Do ALL of the following, then STOP (do NOT write application code or per-feature tasks yet):
1. Write the project overview to swamr/brain/00-project/overview.md
2. Write the tech stack to swamr/brain/00-project/tech-stack.md
3. Write the architecture to swamr/brain/00-project/architecture.md (use [[wikilinks]])
4. Decide ${config.domain_planners} implementation DOMAINS that cleanly partition the system (e.g. data-model, auth, backend-api, frontend-ui, design-system, integrations, realtime, notifications, testing, security). Write swamr/planning/domains.json EXACTLY as:
   [ { "domain": "backend-api", "agent": "backend-architect", "focus": "what this domain owns" } ]
   Use REAL specialist agent slugs from .cursor/rules/ for "agent".
   Also write swamr/brain/01-planning/domains/_index.md as a table of the domains with [[wikilinks]].
5. Write the shared FOUNDATION tasks to swamr/planning/tasks/_foundation.json as an array of:
   { "id": "F1", "phase": "foundation", "description": "...", "agent": "devops-automator", "prompt": "...", "depends_on": [] }
   Use these canonical foundation ids so domain tasks can depend on them:
   F1 = scaffold project, F2 = connect hosted Supabase (no Docker), F3 = database schema/RLS, F4 = auth flow, F5 = env/config, F6 = design system. Keep foundation to 5-8 tasks.
6. Write cross-cutting LIFECYCLE tasks to swamr/planning/tasks/_lifecycle.json covering the later phases (same JSON shape):
   - phase "testing": full end-to-end test suites (id prefix T)
   - phase "security": security hardening / audit (id prefix S), agent security-architect
   - phase "legal": legal & compliance — privacy policy, ToS, data handling (id prefix LG), agent legal-compliance-checker
   - phase "launch": documentation + a handoff doc written to swamr/brain/06-launch/handoff.md + deploy (id prefix L)
   Lifecycle tasks typically depend on the build phase being complete.

Be decisive.`;

  const lead = await runCursorAgent(projectDir, leadPrompt, model, trust);
  leadSpinner.stop(lead.success ? "Architecture and domains ready" : "Lead architect finished (with warnings)");

  let domains = readPlanningDomains(projectDir);
  if (domains.length === 0) {
    warn("No usable swamr/planning/domains.json — falling back to the default domain split");
    domains = DEFAULT_DOMAINS;
  }
  info(`Planning across ${domains.length} domains: ${domains.map((d) => d.domain).join(", ")}`);

  // ── Stage 2: Domain sub-planners (parallel, bounded) ──────────────────────
  header(`Planning 2/3: ${domains.length} domain sub-planners`);
  const planSpinner = new Spinner();
  planSpinner.start(`Fanning out ${domains.length} domain planners`);

  const jobs = domains.map((d) => {
    const prefix = (d.domain.replace(/[^a-zA-Z]/g, "").slice(0, 3) || "DOM").toUpperCase();
    return {
      id: d.domain,
      prompt: `You are the Swamr domain planner for the "${d.domain}" domain. Adopt the @${d.agent} persona (read .cursor/rules/${d.agent}.mdc).

Project: ${description}${adoptContext}

Domain focus: ${d.focus}

READ FIRST: swamr/brain/00-project/overview.md, tech-stack.md, architecture.md, and swamr/planning/domains.json.

Produce a DETAILED, narrowly-scoped task list for ONLY the "${d.domain}" domain. Write it to swamr/planning/tasks/${d.domain}.json as an array of:
{ "id": "${prefix}1", "phase": "build", "description": "...", "agent": "<specialist slug>", "prompt": "<detailed build instructions>", "depends_on": ["F1","F2"] }

RULES:
- Split aggressively: one task per screen / component / endpoint / table / job / test. Prefer MANY small tasks (aim 12-25 for this domain).
- Use unique ids prefixed "${prefix}" so they never collide with other domains.
- Maximize independent tasks (empty depends_on) so waves run wide. Only add depends_on for true ordering; you may depend on foundation ids F1-F6.
- Include this domain's own integration/E2E test tasks with phase "testing".
- Every task MUST have a detailed "prompt".
Also write a short plan note to swamr/brain/01-planning/domains/${d.domain}.md with [[wikilinks]].
Do NOT write application code — only the JSON file and the note.`,
    };
  });

  await runAgentBatch(projectDir, jobs, model, trust, config.domain_planners);
  planSpinner.stop("Domain plans written");

  // ── Stage 3: Deterministic merge + integrator agent ───────────────────────
  header("Planning 3/3: Merge + validate task graph");
  let merged = mergePlanningTaskFiles(projectDir);
  writeFileDeep(path.join(projectDir, "swamr", "tasks.json"), JSON.stringify(merged, null, 2));
  info(`Merged ${merged.length} tasks from ${domains.length} domains + foundation/lifecycle`);

  const integratorPrompt = `You are the Swamr plan integrator (adopt the @project-manager-senior persona).

swamr/tasks.json was just assembled by concatenating foundation, lifecycle, and per-domain task lists. Validate and improve it IN PLACE, then STOP.

Do this:
1. Read swamr/tasks.json, swamr/brain/00-project/architecture.md, and swamr/planning/domains.json.
2. Ensure every task has: id (unique), phase (one of foundation|build|testing|security|legal|launch), description, agent (a real .cursor/rules slug), a detailed prompt, and depends_on (array of EXISTING ids only — remove dangling references and any cycles).
3. Ensure the foundation phase has scaffold + Supabase + schema + auth, the testing phase has real end-to-end coverage, the security and legal phases each have at least one substantive task, and the launch phase has documentation + a handoff doc.
4. If coverage is thin, ADD more tasks so the total is at least ${config.min_build_tasks}. Prefer many small, independent build tasks.
5. Write the final array back to swamr/tasks.json (valid JSON only — no prose).

Do NOT write application code.`;

  await runCursorAgent(projectDir, integratorPrompt, model, trust);

  const finalRaw = readTasksJsonSafe(projectDir);
  if (finalRaw.length > 0) {
    merged = finalRaw;
    info(`Integrator produced ${merged.length} tasks`);
  }
  return merged;
}

// ─── Quality gates (continuous testing) ─────────────────────────────────────
// Deterministic checks run after every wave. Results are written to the brain's
// issues folder so they are surfaced to all workers and the checkpoint agent,
// which files fix tasks for anything failing.
function runQualityGates(projectDir: string): { name: string; ok: boolean; output: string }[] {
  const pkgPath = path.join(projectDir, "package.json");
  if (!fs.existsSync(pkgPath)) return [];
  let pkg: any;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  } catch {
    return [];
  }
  const scripts: Record<string, string> = pkg.scripts ?? {};
  const gateNames: string[] = [];
  for (const candidate of ["type-check", "typecheck", "lint", "test"]) {
    if (scripts[candidate]) gateNames.push(candidate);
  }
  if (gateNames.length === 0) return [];

  const results: { name: string; ok: boolean; output: string }[] = [];
  for (const name of gateNames) {
    const out = runSafe(`npm run ${name} --silent`, projectDir, 180000);
    results.push({ name, ok: out !== null, output: out ?? "FAILED (non-zero exit or timeout)" });
  }

  const failing = results.filter((r) => !r.ok);
  const body = results.map((r) => `- ${r.ok ? "✅" : "❌"} \`npm run ${r.name}\``).join("\n");
  writeFileDeep(
    path.join(projectDir, "swamr", "brain", "03-build", "issues", "quality-gates.md"),
    `---
updated: ${new Date().toISOString()}
failing: ${failing.length}
---

# Quality gates (auto-run after each wave)

${body}

${
  failing.length > 0
    ? `## Failing output\n${failing
        .map((r) => `### npm run ${r.name}\n\`\`\`\n${r.output.slice(-4000)}\n\`\`\``)
        .join("\n\n")}\n\nThe next checkpoint agent must file fix tasks for each failure.`
    : "All gates passing."
}
`
  );
  return results;
}

// ─── Obsidian brain re-index ────────────────────────────────────────────────
// Regenerates the live-status block in index.md with wikilinks to every task
// output so agents can see "what's done" at a glance.
function reindexBrain(projectDir: string, state: SwamrState): void {
  const indexPath = path.join(projectDir, "swamr", "brain", "index.md");
  if (!fs.existsSync(indexPath)) return;

  const byStatus = (s: TaskDef["status"]) => state.tasks.filter((t) => t.status === s);
  const completed = byStatus("completed");
  const inProgress = byStatus("in_progress");
  const pending = byStatus("pending");
  const blocked = byStatus("blocked");
  const failed = byStatus("failed");
  const skipped = byStatus("skipped");
  const activePhase = getActivePhase(state) ?? state.current_phase;
  const trackable = state.tasks.filter((t) => t.status !== "skipped").length;

  const link = (t: TaskDef) =>
    `[[03-build/task-outputs/${t.id}|${t.id}]] — ${t.description}`;
  const section = (title: string, list: TaskDef[]) =>
    list.length
      ? `### ${title} (${list.length})\n${list.slice(0, 60).map((t) => `- ${link(t)}`).join("\n")}\n`
      : "";

  const status = `## Live Status
- **Phase**: ${activePhase}
- **Tasks**: ${completed.length}/${trackable} completed
- **Blocked**: ${blocked.length} · **Failed**: ${failed.length} · **Skipped**: ${skipped.length}
- **Last Updated**: ${new Date().toISOString()}

${section("Completed", completed)}
${section("In progress", inProgress)}
${section("Pending", pending)}
${section("Blocked (needs you)", blocked)}
${section("Failed", failed)}`;

  const content = fs.readFileSync(indexPath, "utf-8");
  const start = "<!-- SWAMR:LIVE-STATUS:START -->";
  const end = "<!-- SWAMR:LIVE-STATUS:END -->";
  const si = content.indexOf(start);
  const ei = content.indexOf(end);
  let next: string;
  if (si !== -1 && ei !== -1 && ei > si) {
    next = content.slice(0, si + start.length) + "\n" + status + "\n" + content.slice(ei);
  } else {
    next = content + "\n" + start + "\n" + status + "\n" + end + "\n";
  }
  writeFileDeep(indexPath, next);
}

async function runTaskBatch(
  projectDir: string,
  tasks: TaskDef[],
  state: SwamrState,
  config: SwamrConfig,
  model: string,
  trust: boolean = false,
  dashboard?: ProgressDashboard,
  opts: { waveSize: number; runCheckpoint: boolean; phase: string } = {
    waveSize: config.wave_size,
    runCheckpoint: config.checkpoint_between_waves,
    phase: "build",
  }
): Promise<void> {
  ensureStateDefaults(state);
  if (!state.phase_waves) state.phase_waves = {};

  // pending = anything still actionable. Failed, blocked, and skipped tasks are
  // terminal for this run unless `swamr continue` requeues them.
  let pending = tasks.filter((t) => t.status === "pending");
  let wave = state.phase_waves[opts.phase] ?? 0;

  while (pending.length > 0) {
    const ready = pending.filter((t) =>
      t.depends_on.every((dep) => {
        const depTask = state.tasks.find((st) => st.id === dep);
        return depTask?.status === "completed";
      })
    );

    if (ready.length === 0) {
      // Nothing can run: either a real dependency cycle or remaining tasks are
      // unreachable because an upstream task failed/blocked/skipped.
      const skipped = markUnreachable(projectDir, pending, state);
      if (skipped > 0) {
        pending = pending.filter((t) => t.status === "pending");
        warn(`${skipped} task(s) skipped because dependencies are failed or blocked`);
      } else {
        warn("No tasks ready — possible dependency deadlock");
      }
      break;
    }

    wave++;
    const batch = ready.slice(0, Math.max(1, opts.waveSize));
    state.checkpoint_pending = true;
    saveState(projectDir, state);
    if (dashboard) dashboard.wave = wave;

    const promises = batch.map(async (task) => {
      task.status = "in_progress";
      task.attempts++;
      saveState(projectDir, state);

      if (dashboard) {
        dashboard.activeTasks = tasks
          .filter((t) => t.status === "in_progress")
          .map((t) => ({ id: t.id, description: t.description } as ProgressTask));
      }

      // If a blocker still exists, skip (autoVerifyBlockers on continue should have cleared resolved ones).
      const existingBlocker = readBlocker(projectDir, task.id);
      if (existingBlocker) {
        task.status = "blocked";
        if (dashboard) {
          dashboard.activeTasks = tasks
            .filter((t) => t.status === "in_progress")
            .map((t) => ({ id: t.id, description: t.description } as ProgressTask));
          dashboard.blockedCount = state.tasks.filter((t) => t.status === "blocked").length;
        }
        saveState(projectDir, state);
        return;
      }

      const fullPrompt = buildTaskPrompt(
        task,
        buildBrainContext(projectDir, task, opts.phase),
        projectDir
      );
      const result = await runCursorAgent(projectDir, fullPrompt, model, trust);

      // Blocker takes priority: the worker may have written one, or we infer it.
      const writtenBlocker = readBlocker(projectDir, task.id);
      if (writtenBlocker) {
        task.status = "blocked";
      } else if (result.success) {
        task.status = "completed";
        task.output = result.output.slice(-500);
        if (dashboard) {
          dashboard.phaseCompleted++;
          dashboard.overallCompleted++;
        }
      } else {
        const inferred = detectManualStep(result.output, task);
        if (inferred) {
          writeBlocker(projectDir, inferred);
          task.status = "blocked";
        } else if (task.attempts >= config.max_retries_per_task) {
          task.status = "failed";
        } else {
          task.status = "pending";
        }
      }

      if (dashboard) {
        dashboard.activeTasks = tasks
          .filter((t) => t.status === "in_progress")
          .map((t) => ({ id: t.id, description: t.description } as ProgressTask));
        dashboard.blockedCount = state.tasks.filter((t) => t.status === "blocked").length;
      }

      const maxBrainChars = 50000;
      const agentOutput =
        result.output.length > maxBrainChars
          ? `[...truncated ${result.output.length - maxBrainChars} chars...]\n${result.output.slice(-maxBrainChars)}`
          : result.output;

      writeFileDeep(
        path.join(projectDir, "swamr", "brain", "03-build", "task-outputs", `${task.id}.md`),
        `---
task_id: ${task.id}
agent: ${task.agent}
status: ${task.status}
attempts: ${task.attempts}
date: ${new Date().toISOString()}
---

# ${task.description}

## Agent Output
${agentOutput}
`
      );
      appendPhaseLog(projectDir, `- ${task.id}: ${task.status} (attempt ${task.attempts})`);

      saveState(projectDir, state);
    });

    await Promise.all(promises);

    // Surface any new manual-step blockers immediately (non-blocking: other waves continue).
    const blockers = collectBlockers(projectDir, state);
    writeNeedsYou(projectDir, blockers);
    if (dashboard) dashboard.blockedCount = blockers.length;

    // Remove tasks that are done for this run from pending.
    pending = pending.filter((t) => t.status === "pending");

    // Continuous testing: deterministic quality gates after every wave. Results
    // land in the brain's issues folder so workers + the checkpoint see them.
    const gates = runQualityGates(projectDir);
    const failingGates = gates.filter((g) => !g.ok);
    if (failingGates.length > 0) {
      warn(
        `Quality gates failing: ${failingGates
          .map((g) => g.name)
          .join(", ")} — see swamr/brain/03-build/issues/quality-gates.md`
      );
    }

    // Re-evaluation + verification checkpoint between waves: a single agent
    // assesses progress, runs deep verification in verify phases, files fix
    // tasks for any failing gate/bug, and may split large tasks into subtasks.
    if (opts.runCheckpoint && pending.length > 0) {
      if (dashboard) dashboard.checkpoint = true;
      await runCheckpointAgent(projectDir, state, wave, opts.phase, model, trust);
      mergeNewTasks(projectDir, state, opts.phase, pending);
      if (dashboard) dashboard.checkpoint = false;
    }

    // Keep dashboard totals in sync (splits/fix tasks change the task count).
    if (dashboard) {
      dashboard.overallTotal = state.tasks.filter((t) => t.status !== "skipped").length;
      dashboard.overallCompleted = state.tasks.filter((t) => t.status === "completed").length;
      const phaseAll = state.tasks.filter((t) => t.phase === opts.phase && t.status !== "skipped");
      dashboard.phaseTotal = phaseAll.length;
      dashboard.phaseCompleted = phaseAll.filter((t) => t.status === "completed").length;
    }

    reindexBrain(projectDir, state);

    state.phase_waves![opts.phase] = wave;
    saveState(projectDir, state);
  }
}

// One agent re-evaluates "where are we at" between waves and writes a checkpoint note.
async function runCheckpointAgent(
  projectDir: string,
  state: SwamrState,
  wave: number,
  phase: string,
  model: string,
  trust: boolean,
  opts: { onContinue?: boolean } = {}
): Promise<boolean> {
  ensureStateDefaults(state);
  const completed = state.tasks.filter((t) => t.status === "completed").length;
  const blocked = state.tasks.filter((t) => t.status === "blocked").length;
  const failed = state.tasks.filter((t) => t.status === "failed").length;
  const remaining = state.tasks.filter(
    (t) => t.status === "pending" || t.status === "failed"
  ).length;

  const checkpointRelPath = `swamr/brain/03-build/checkpoints/${checkpointFileName(phase, wave)}`;
  const brainContext = buildBrainContext(projectDir, undefined, phase);
  const isVerify = VERIFY_PHASES.has(phase);
  const contextLabel = opts.onContinue
    ? `Resuming build — re-evaluate before dispatching workers.`
    : `Wave ${wave} of the "${phase}" phase just finished.`;

  const prompt = `You are the Swamr re-evaluation + verification checkpoint (use the @reality-checker persona). ${contextLabel}

Current tally: ${completed} completed, ${remaining} remaining, ${blocked} blocked (waiting on a human), ${failed} failed.

PRE-LOADED BRAIN CONTEXT (also read swamr/state.json for live task statuses):
${brainContext.slice(0, 12000)}

Do the following, then STOP. Do NOT write application code.
1. Read swamr/state.json — it is the source of truth for task statuses.
2. Assess progress: what is actually done vs claimed, any duplicated/conflicting work, and any task that is stuck making no real progress.
3. CONTINUOUS TESTING: read swamr/brain/03-build/issues/quality-gates.md (type-check / lint / test results) and the recent task outputs. For EVERY failing gate, regression, or bug, APPEND a fix task to swamr/tasks.json so the swarm repairs it and it gets re-tested next wave.${
    isVerify
      ? `\n4. DEEP VERIFICATION (this is a "${phase}" phase): actually exercise the work — run the relevant test scripts (npm run test:*), curl key endpoints, run type-check, or launch the simulator — and file a task for every defect you find.`
      : ""
  }
${isVerify ? "5" : "4"}. Write a concise checkpoint note to ${checkpointRelPath} with: progress summary, test/verification results, risks, and recommended next actions.
${isVerify ? "6" : "5"}. To split a too-large/stuck task OR to file a fix/bug task, APPEND new task objects to swamr/tasks.json using the SAME schema { "id", "phase", "description", "agent", "prompt", "depends_on" }. Use new unique ids (e.g. "${phase[0].toUpperCase()}${wave}a"). For SPLITS, set "phase" to "${phase}" and start the prompt with "{parentId} split — …" so the orchestrator supersedes the parent. For FIX/BUG tasks, choose the right phase and a fitting specialist agent. Do NOT modify or remove existing tasks.

Keep it brief and decisive.`;

  const result = await runCursorAgent(projectDir, prompt, model, trust);
  const checkpointPath = checkpointFilePath(projectDir, phase, wave);
  const legacyPath = path.join(
    projectDir,
    "swamr",
    "brain",
    "03-build",
    "checkpoints",
    `wave-${wave}.md`
  );
  const written =
    fs.existsSync(checkpointPath) ||
    (phase === "foundation" && wave === 1 && fs.existsSync(legacyPath));

  if (result.success && written) {
    state.last_checkpoint = { phase, wave, at: new Date().toISOString() };
    state.checkpoint_pending = false;
    saveState(projectDir, state);
    info(`Checkpoint saved: ${checkpointRelPath}`);
    return true;
  }

  state.checkpoint_pending = true;
  saveState(projectDir, state);
  if (!result.success) {
    warn(`Checkpoint agent failed for ${phase} wave ${wave} — will retry on next continue`);
  } else {
    warn(
      `Checkpoint agent finished but ${checkpointRelPath} was not written — will retry on next continue`
    );
  }
  return false;
}

/** When a checkpoint splits task X into subtasks, skip X so agents do not duplicate work. */
function supersedeSplitParents(state: SwamrState, newTasks: TaskDef[]): void {
  const splitsByParent = new Map<string, string[]>();
  for (const t of newTasks) {
    const match = t.prompt.match(/^([A-Za-z0-9]+)\s+split\s/i);
    if (!match) continue;
    const parentId = match[1];
    const childIds = splitsByParent.get(parentId) ?? [];
    childIds.push(t.id);
    splitsByParent.set(parentId, childIds);
  }

  for (const [parentId, childIds] of splitsByParent) {
    const parent = state.tasks.find((t) => t.id === parentId);
    if (!parent || parent.status === "completed" || parent.status === "skipped") continue;
    parent.status = "skipped";
    parent.blocked_by = childIds;
    parent.output = `Superseded by checkpoint split into ${childIds.join(", ")}`;
    info(`Task [${parentId}] superseded by split subtasks: ${childIds.join(", ")}`);
  }
}

// After a checkpoint, pick up any new subtasks the checkpoint agent appended to tasks.json.
function mergeNewTasks(
  projectDir: string,
  state: SwamrState,
  phase: string,
  pending: TaskDef[]
): void {
  const tasksPath = path.join(projectDir, "swamr", "tasks.json");
  if (!fs.existsSync(tasksPath)) return;
  let raw: any[];
  try {
    raw = JSON.parse(fs.readFileSync(tasksPath, "utf-8"));
  } catch {
    return;
  }
  const known = new Set(state.tasks.map((t) => t.id));
  const addedTasks: TaskDef[] = [];
  for (const t of raw) {
    if (!t?.id || known.has(t.id)) continue;
    const newTask: TaskDef = {
      id: t.id,
      phase: t.phase ?? phase,
      description: t.description ?? t.id,
      agent: t.agent ?? "senior-developer",
      prompt: t.prompt ?? "",
      depends_on: Array.isArray(t.depends_on) ? t.depends_on : [],
      status: "pending",
      attempts: 0,
    };
    state.tasks.push(newTask);
    addedTasks.push(newTask);
    if (newTask.phase === phase) pending.push(newTask);
  }

  if (addedTasks.length === 0) return;

  supersedeSplitParents(state, addedTasks);
  // Drop superseded parents from the pending queue for this run.
  for (let i = pending.length - 1; i >= 0; i--) {
    if (pending[i].status === "skipped") pending.splice(i, 1);
  }

  info(`Checkpoint split work into ${addedTasks.length} new subtask(s)`);
  saveState(projectDir, state);
}

function buildTaskPrompt(task: TaskDef, brainContext: string, projectDir: string): string {
  const planPath = path.join(projectDir, "swamr", "plan.md");
  const plan = fs.existsSync(planPath) ? fs.readFileSync(planPath, "utf-8") : "";

  return `You are working as part of the Swamr agent swarm.

Your assigned role: @${task.agent}
Your task (${task.id}): ${task.description}

STEP 0 — ADOPT YOUR SPECIALIST PERSONA (MANDATORY, do this first):
Read the file .cursor/rules/${task.agent}.mdc and FULLY adopt that specialist's persona, methodology, conventions, and quality bar for this entire task. Apply that expertise throughout. If .cursor/rules/${task.agent}.mdc does not exist, read the closest-matching .cursor/rules/*.mdc for your role and adopt it. You MUST work as this specialist, not as a generic assistant.

INSTRUCTIONS:
${task.prompt}

PROJECT CONTEXT (from Obsidian brain):
${brainContext}

READ BEFORE CODING: Check dependency task outputs and user-context.md above for manual changes, bundle IDs, and known runtime issues (swamr/brain/03-build/issues/).

PROJECT PLAN:
${plan.slice(0, 3000)}

RULES:
1. Complete ONLY your assigned task — do not work on other tasks
2. Write production-quality code with proper TypeScript types
3. TEST WHAT YOU CHANGE: add and/or run a concrete test for your change before claiming success — a test script, a curl against the endpoint, an Expo/simulator check, or at minimum npm run type-check / lint. Note the evidence in your summary.
4. After completing your work, write a brief summary of what you did
5. If you find issues or make architecture decisions, note them clearly
6. Do NOT modify swamr/ or .cursor/ directories (the one exception is the blocker file described below)
7. Handle errors gracefully — no unhandled promise rejections
8. Follow existing code patterns and naming conventions in the project

SUPABASE (HOSTED ONLY — NO DOCKER):
Never use Docker or supabase start. Local Supabase is not supported.

HUMAN MANUAL STEPS (F2 — write blocker if missing):
1. Create project: https://supabase.com/dashboard → New project (save database password)
2. Settings → API: copy Project URL (https://<ref>.supabase.co)
3. Same page: copy anon public key → EXPO_PUBLIC_SUPABASE_ANON_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local
4. Same page: copy service_role secret → SUPABASE_SERVICE_ROLE_KEY in .env.local (server only)
5. Optional: supabase login for CLI

AI HANDLES EVERYTHING ELSE via Supabase MCP:
- list_projects, apply_migration, execute_sql, list_migrations, list_tables, get_advisors, generate_typescript_types
- F3+ schema, RLS, indexes, PostGIS, seed data — all via MCP migrations (not Docker)
- supabase link + db push when CLI is authenticated
- npm run test:supabase to verify

If keys are missing, write swamr/blockers/F2.json with exact dashboard URLs — do not use Docker.

MANUAL-STEP / BLOCKER PROTOCOL (IMPORTANT):
If you cannot finish because of something only a human can do — authenticating an MCP server,
creating a Supabase/Google Cloud/other hosted project, providing an API key or secret, creating
or upgrading an account, billing, or clicking through a web GUI/dashboard — do NOT keep retrying,
wait, or fake the result. This is especially important for setup/infrastructure tasks. Instead:
1. Write the file swamr/blockers/${task.id}.json with EXACTLY this JSON shape:
   {
     "task_id": "${task.id}",
     "title": "<short title of what's blocked>",
     "what_i_need": "<the precise manual action the user must take>",
     "why": "<why you cannot proceed without it>",
     "steps": ["<step 1>", "<step 2>"]
   }
2. Then stop and end your turn. The orchestrator will surface this to the user and move on to
   other tasks. Do NOT write the blocker file unless you are genuinely blocked on a human action.

${task.attempts > 1 ? `\nNOTE: This is retry attempt ${task.attempts}. Previous attempt failed. Make sure to check for existing files before creating new ones, and fix any issues from the previous attempt.\n` : ""}

Begin working now. Complete the task fully.`;
}

async function executeBuild(
  projectDir: string,
  state: SwamrState,
  config: SwamrConfig,
  workerModel: string,
  trust: boolean
): Promise<void> {
  // --- PHASE 2+: EXECUTE TASKS BY PHASE ---
  const phases = [...BUILD_PHASES];
  const totalTasks = state.tasks.length;
  const alreadyDone = state.tasks.filter((t) => t.status === "completed").length;

  const dashboard = new ProgressDashboard();
  dashboard.totalPhases = phases.filter((p) => state.tasks.some((t) => t.phase === p)).length;
  dashboard.overallTotal = totalTasks;
  dashboard.overallCompleted = alreadyDone;
  dashboard.start();

  const preflightIssues = runProjectPreflight(projectDir);
  if (preflightIssues.length > 0) {
    warn(`Runtime preflight: ${preflightIssues.length} issue(s) logged to swamr/brain/03-build/issues/`);
  }

  let phaseCounter = 0;

  for (const phase of phases) {
    const phaseTasks = state.tasks.filter((t) => t.phase === phase);
    if (phaseTasks.length === 0) continue;

    const allDone = phaseTasks.every((t) => t.status === "completed");
    if (allDone) continue;

    phaseCounter++;
    state.current_phase = phase;
    saveState(projectDir, state);

    dashboard.phase = phase;
    dashboard.phaseIndex = phaseCounter;
    dashboard.phaseCompleted = phaseTasks.filter((t) => t.status === "completed").length;
    dashboard.phaseTotal = phaseTasks.length;
    dashboard.activeTasks = [];

    // Verification phases run smaller waves and always check between them.
    const verify = VERIFY_PHASES.has(phase);
    const waveSize = verify ? config.verify_wave_size : config.wave_size;
    const runCheckpoint = verify ? true : config.checkpoint_between_waves;

    await runTaskBatch(projectDir, phaseTasks, state, config, workerModel, trust, dashboard, {
      waveSize,
      runCheckpoint,
      phase,
    });

    // Write phase summary to brain
    const completed = phaseTasks.filter((t) => t.status === "completed").length;
    const failed = phaseTasks.filter((t) => t.status === "failed").length;
    const skipped = phaseTasks.filter((t) => t.status === "skipped").length;

    writeFileDeep(
      path.join(projectDir, "swamr", "brain", phaseBrainDir(phase), "phase-summary.md"),
      `---
phase: ${phase}
completed: ${new Date().toISOString()}
tasks_completed: ${completed}
tasks_failed: ${failed}
tasks_skipped: ${skipped}
---

# Phase Summary: ${phase}

## Results
- Tasks completed: ${completed}/${phaseTasks.length}
- Tasks failed: ${failed}/${phaseTasks.length}
- Tasks skipped: ${skipped}/${phaseTasks.length}

## Completed Tasks
${phaseTasks
  .filter((t) => t.status === "completed")
  .map((t) => `- ${t.id}: ${t.description}`)
  .join("\n")}

${failed > 0 ? `## Failed Tasks\n${phaseTasks.filter((t) => t.status === "failed").map((t) => `- ${t.id}: ${t.description}`).join("\n")}` : ""}
${skipped > 0 ? `## Skipped Tasks\n${phaseTasks.filter((t) => t.status === "skipped").map((t) => `- ${t.id}: ${t.description}${t.blocked_by?.length ? ` (blocked by ${t.blocked_by.join(", ")})` : ""}`).join("\n")}` : ""}
`
    );

    saveState(projectDir, state);

    if (failed > 0 || skipped > 0) {
      dashboard.stop();
      if (failed > 0) warn(`Phase "${phase}" had ${failed} failed tasks`);
      if (skipped > 0) warn(`Phase "${phase}" skipped ${skipped} task(s) due to failed or blocked dependencies`);
      dashboard.start();
    }
  }

  dashboard.stop();

  // --- DONE ---
  const totalCompleted = state.tasks.filter((t) => t.status === "completed").length;
  const totalFailed = state.tasks.filter((t) => t.status === "failed").length;
  const totalSkipped = state.tasks.filter((t) => t.status === "skipped").length;
  const blockers = collectBlockers(projectDir, state);
  writeNeedsYou(projectDir, blockers);

  state.status =
    blockers.length > 0
      ? "blocked"
      : totalFailed === 0 && totalSkipped === 0
        ? "completed"
        : "completed_with_errors";
  saveState(projectDir, state);
  reindexBrain(projectDir, state);

  console.log();
  header("🐝 Swamr Build Complete!");
  console.log();
  console.log(`  Tasks completed: ${totalCompleted}/${state.tasks.length}`);
  console.log(`  Tasks failed:    ${totalFailed}`);
  console.log(`  Tasks skipped:   ${totalSkipped}`);
  console.log(`  Tasks blocked:   ${blockers.length}`);
  console.log(`  Brain notes:     swamr/brain/`);
  console.log(`  State:           swamr/state.json`);
  console.log();

  printNeedsYou(blockers);
}

export async function build(
  targetDir: string,
  description: string,
  options: { model?: string; plan_only?: boolean; trust?: boolean } = {}
) {
  const projectDir = path.resolve(targetDir);
  const config = loadConfig(projectDir);
  const plannerModel = options.model ?? "auto";
  const workerModel = options.model ?? "auto";
  const trust = options.trust ?? false;

  // Check cursor agent is available
  const cursorCheck = runSafe("cursor agent --version");
  if (!cursorCheck) {
    console.error("\n❌ cursor agent CLI not found or not authenticated.");
    console.error("Run: cursor agent login");
    console.error("Then try again.\n");
    process.exit(1);
  }

  // Preflight: headless agents can't complete an interactive MCP auth/approval in the GUI,
  // so they'd silently hang (the F2 Supabase case). Catch it up front with clear instructions.
  const pre = preflightMcp(projectDir, config);
  if (!pre.ok) {
    header("🙋 Manual step needed before the swarm can start");
    console.log();
    console.log("  These MCP servers aren't ready — agents would hang waiting on them:");
    for (const s of pre.notReady) {
      console.log(`    • ${bold(s.name)} — ${s.status}`);
    }
    console.log();
    console.log("  To fix, authenticate/approve each one:");
    for (const s of pre.notReady) {
      console.log(`    cursor agent mcp login ${s.name}`);
    }
    console.log("  (or open Cursor → Settings → MCP and approve/authenticate it)");
    console.log();
    console.log(`  Then re-run:  ${bold("swamr continue")}`);
    console.log();
    process.exit(1);
  }

  header("🐝 Swamr — Multi-Agent Build");
  console.log(`  Project:    ${projectDir}`);
  console.log(`  Workers:    up to ${config.max_concurrent_agents} concurrent agents (~${config.min_build_tasks}+ total across waves)`);
  console.log(`  Planner:    ${plannerModel}`);
  console.log(`  Workers:    ${workerModel}`);
  console.log(`  Trust mode: ${trust ? "ON (auto-approve all commands)" : "OFF (agents will ask before running commands)"}`);
  console.log();

  // Check for existing state (resume)
  let state = loadState(projectDir);
  if (state && state.tasks.some((t) => t.status !== "completed")) {
    header("Resuming from previous state...");
    const completed = state.tasks.filter((t) => t.status === "completed").length;
    const total = state.tasks.length;
    info(`${completed}/${total} tasks already completed`);

    // Re-check blockers: if the user resolved one (deleted the blocker file), requeue the task.
    let cleared = 0;
    for (const t of state.tasks) {
      if (t.status === "blocked" && !readBlocker(projectDir, t.id)) {
        t.status = "pending";
        cleared++;
      }
    }
    if (cleared > 0) {
      info(`${cleared} previously-blocked task(s) cleared — requeued`);
      saveState(projectDir, state);
    }
    const stillBlocked = collectBlockers(projectDir, state);
    writeNeedsYou(projectDir, stillBlocked);
    if (stillBlocked.length > 0) {
      printNeedsYou(stillBlocked);
    }
  } else {
    // --- PHASE 1: HIERARCHICAL PLANNING ---
    header("Phase 1: Hierarchical Planning");
    const rawTasks = await runHierarchicalPlanning(
      projectDir,
      description,
      config,
      plannerModel,
      trust
    );

    if (rawTasks.length === 0) {
      console.error("❌ Planning produced no tasks (swamr/tasks.json empty).");
      console.error("The planning agents need to write swamr/planning/tasks/*.json or swamr/tasks.json.");
      process.exit(1);
    }

    const tasks: TaskDef[] = rawTasks.map((t: any) => ({
      ...t,
      status: "pending" as const,
      attempts: 0,
    }));

    state = {
      project: description.slice(0, 100),
      status: "building",
      current_phase: "foundation",
      started_at: new Date().toISOString(),
      tasks,
      phase_waves: {},
      last_checkpoint: null,
      checkpoint_pending: false,
    };
    saveState(projectDir, state);
    reindexBrain(projectDir, state);
    info(`Plan created with ${tasks.length} tasks`);

    if (options.plan_only) {
      header("✅ Plan created. Review swamr/plan.md and swamr/tasks.json");
      console.log("Run 'swamr continue' to execute the plan.");
      return;
    }
  }

  await executeBuild(projectDir, state!, config, workerModel, trust);
}

function printResumeSummary(
  projectDir: string,
  state: SwamrState,
  requeuedIds: string[] = []
) {
  ensureStateDefaults(state);
  const activePhase = getActivePhase(state) ?? state.current_phase;
  const currentWave = activePhase ? (state.phase_waves?.[activePhase] ?? 0) : 0;

  const counts = {
    completed: state.tasks.filter((t) => t.status === "completed").length,
    pending: state.tasks.filter((t) => t.status === "pending").length,
    failed: state.tasks.filter((t) => t.status === "failed").length,
    skipped: state.tasks.filter((t) => t.status === "skipped").length,
    blocked: state.tasks.filter((t) => t.status === "blocked").length,
    inProgress: state.tasks.filter((t) => t.status === "in_progress").length,
  };

  header("Resume summary");
  console.log(`  Current phase: ${activePhase}${currentWave > 0 ? ` (wave ${currentWave})` : ""}`);
  console.log(`  Completed:     ${counts.completed}/${state.tasks.length}`);
  console.log(`  Pending:       ${counts.pending}`);
  console.log(`  Failed:        ${counts.failed}`);
  console.log(`  Skipped:       ${counts.skipped}`);
  console.log(`  Blocked:       ${counts.blocked}`);
  if (counts.inProgress > 0) console.log(`  In progress:   ${counts.inProgress} (will be requeued)`);
  if (requeuedIds.length > 0) {
    console.log(
      `  Requeued:      ${requeuedIds.join(", ")} (interrupted — will retry, not re-implement completed work)`
    );
  }
  if (state.checkpoint_pending) {
    console.log(`  Checkpoint:    pending (re-evaluation will run before workers)`);
  }

  const blockers = collectBlockers(projectDir, state);
  if (blockers.length > 0) {
    console.log();
    console.log("  Needs you:");
    for (const blocker of blockers) {
      console.log(`    • [${blocker.task_id}] ${blocker.what_i_need}`);
    }
  }

  const dependencySkips = state.tasks.filter((t) => t.status === "skipped" && t.blocked_by?.length);
  if (dependencySkips.length > 0) {
    console.log();
    console.log("  Dependency skips:");
    for (const task of dependencySkips.slice(0, 10)) {
      console.log(`    • [${task.id}] blocked by ${task.blocked_by!.join(", ")}`);
    }
    if (dependencySkips.length > 10) {
      console.log(`    • ...and ${dependencySkips.length - 10} more`);
    }
  }
  console.log();
}

function recheckBlockers(projectDir: string, state: SwamrState): number {
  let cleared = 0;
  for (const task of state.tasks) {
    if (task.status === "blocked" && !readBlocker(projectDir, task.id)) {
      task.status = "pending";
      task.blocked_by = undefined;
      cleared++;
    }
  }
  return cleared;
}

/** If a task was split into subtasks, retire the parent so agents do not redo the same work. */
function reconcileSupersededTasks(state: SwamrState): number {
  const splitsByParent = new Map<string, TaskDef[]>();
  for (const t of state.tasks) {
    const match = t.prompt.match(/^([A-Za-z0-9]+)\s+split\s/i);
    if (!match) continue;
    const parentId = match[1];
    const children = splitsByParent.get(parentId) ?? [];
    children.push(t);
    splitsByParent.set(parentId, children);
  }

  let reconciled = 0;
  for (const [parentId, children] of splitsByParent) {
    const parent = state.tasks.find((t) => t.id === parentId);
    if (!parent || parent.status === "completed" || parent.status === "skipped") continue;

    const childIds = children.map((c) => c.id).join(", ");
    if (children.every((c) => c.status === "completed")) {
      parent.status = "completed";
      parent.output = `Superseded by split subtasks (all complete): ${childIds}`;
      reconciled++;
      info(`Task [${parentId}] completed — split subtasks done: ${childIds}`);
    } else {
      parent.status = "skipped";
      parent.blocked_by = children.map((c) => c.id);
      parent.output = `Superseded by split subtasks: ${childIds}`;
      reconciled++;
      info(`Task [${parentId}] superseded by split subtasks: ${childIds}`);
    }
  }
  return reconciled;
}

function requeueRecoverableTasks(state: SwamrState): string[] {
  const requeued: string[] = [];
  for (const task of state.tasks) {
    if (task.status === "failed" || task.status === "in_progress") {
      if (task.status === "failed") task.attempts = 0;
      task.status = "pending";
      task.blocked_by = undefined;
      requeued.push(task.id);
    }
  }
  return requeued;
}

async function runContinueCheckpoint(
  projectDir: string,
  state: SwamrState,
  config: SwamrConfig,
  model: string,
  trust: boolean
): Promise<void> {
  if (!config.checkpoint_between_waves) return;

  const activePhase = getActivePhase(state);
  if (!activePhase) return;

  ensureStateDefaults(state);
  const wave = Math.max(1, state.phase_waves?.[activePhase] ?? 0);

  header("Re-evaluation checkpoint (on continue)");
  info(`Running @reality-checker for ${activePhase} wave ${wave} before dispatching workers`);

  await runCheckpointAgent(projectDir, state, wave, activePhase, model, trust, {
    onContinue: true,
  });

  const phaseTasks = state.tasks.filter((t) => t.phase === activePhase);
  const pending = phaseTasks.filter((t) => t.status === "pending");
  mergeNewTasks(projectDir, state, activePhase, pending);
  reconcileSupersededTasks(state);
  saveState(projectDir, state);
}

export async function continueBuild(
  targetDir: string,
  options: { model?: string; trust?: boolean; message?: string } = {}
) {
  const projectDir = path.resolve(targetDir);
  const config = loadConfig(projectDir);
  const workerModel = options.model ?? "auto";
  const trust = options.trust ?? false;

  const cursorCheck = runSafe("cursor agent --version");
  if (!cursorCheck) {
    console.error("\n❌ cursor agent CLI not found or not authenticated.");
    console.error("Run: cursor agent login");
    console.error("Then try again.\n");
    process.exit(1);
  }

  const state = loadState(projectDir);
  if (!state) {
    console.error("\n❌ No previous Swamr build found.");
    console.error("Run: swamr build --dir <project-dir> \"Your app description\"");
    console.error("Then use: swamr continue --dir <project-dir>\n");
    process.exit(1);
  }

  header("🐝 Swamr — Continue Build");
  console.log(`  Project:    ${projectDir}`);
  console.log(`  Workers:    up to ${config.max_parallel_agents} parallel agents`);
  console.log(`  Workers:    ${workerModel}`);
  console.log(`  Trust mode: ${trust ? "ON (auto-approve all commands)" : "OFF (agents will ask before running commands)"}`);
  console.log();

  ensureStateDefaults(state);
  const activePhase = getActivePhase(state);
  if (activePhase) state.current_phase = activePhase;

  if (options.message?.trim()) {
    writeUserContext(projectDir, options.message.trim());
    info(`User context saved to swamr/brain/03-build/user-context.md`);
  }

  const preflightIssues = runProjectPreflight(projectDir);
  if (preflightIssues.length > 0) {
    warn(`Runtime preflight found ${preflightIssues.length} issue(s) — logged to swamr/brain/03-build/issues/`);
    for (const issue of preflightIssues) console.log(`    • ${issue}`);
    console.log();
  }

  const autoVerified = autoVerifyBlockers(projectDir, state, options.message);
  if (autoVerified > 0) {
    info(`${autoVerified} blocker(s) auto-verified and marked complete`);
  }

  const cleared = recheckBlockers(projectDir, state);
  if (cleared > 0) {
    info(`${cleared} resolved blocker(s) requeued`);
  }

  const reconciled = reconcileSupersededTasks(state);
  if (reconciled > 0) {
    info(`${reconciled} superseded parent task(s) reconciled`);
  }

  const requeuedIds = requeueRecoverableTasks(state);
  if (requeuedIds.length > 0) {
    info(`${requeuedIds.length} failed/in-progress task(s) requeued: ${requeuedIds.join(", ")}`);
  }

  printResumeSummary(projectDir, state, requeuedIds);

  const stillBlocked = collectBlockers(projectDir, state);
  writeNeedsYou(projectDir, stillBlocked);
  if (stillBlocked.length > 0) printNeedsYou(stillBlocked);
  saveState(projectDir, state);

  const pre = preflightMcp(projectDir, config);
  if (!pre.ok) {
    header("🙋 Manual step needed before the swarm can continue");
    console.log();
    console.log("  These MCP servers aren't ready — agents would hang waiting on them:");
    for (const server of pre.notReady) {
      console.log(`    • ${bold(server.name)} — ${server.status}`);
    }
    console.log();
    console.log("  To fix, authenticate/approve each one:");
    for (const server of pre.notReady) {
      console.log(`    cursor agent mcp login ${server.name}`);
    }
    console.log("  (or open Cursor → Settings → MCP and approve/authenticate it)");
    console.log();
    console.log(`  Then re-run:  ${bold("swamr continue")}`);
    console.log();
    process.exit(1);
  }

  await runContinueCheckpoint(projectDir, state, config, workerModel, trust);

  await executeBuild(projectDir, state, config, workerModel, trust);
}

/**
 * Adopt an EXISTING project that Swamr did not create. A discovery agent
 * inventories the repo, then the hierarchical planner plans ONLY the remaining
 * work (seeded by `-m`), and the swarm builds from the current state.
 *
 * Differs from `continue`, which resumes an existing swamr/state.json. `adopt`
 * bootstraps a fresh plan from whatever code already exists.
 */
export async function adoptBuild(
  targetDir: string,
  options: { model?: string; trust?: boolean; message?: string } = {}
) {
  const projectDir = path.resolve(targetDir);
  const config = loadConfig(projectDir);
  const plannerModel = options.model ?? "auto";
  const workerModel = options.model ?? "auto";
  const trust = options.trust ?? false;

  const cursorCheck = runSafe("cursor agent --version");
  if (!cursorCheck) {
    console.error("\n❌ cursor agent CLI not found or not authenticated.");
    console.error("Run: cursor agent login");
    console.error("Then try again.\n");
    process.exit(1);
  }

  header("🐝 Swamr — Adopt Existing Project");
  console.log(`  Project:    ${projectDir}`);
  console.log(`  Workers:    up to ${config.max_concurrent_agents} concurrent agents (~${config.min_build_tasks}+ total across waves)`);
  console.log(`  Planner:    ${plannerModel}`);
  console.log(`  Trust mode: ${trust ? "ON (auto-approve all commands)" : "OFF (agents will ask before running commands)"}`);
  if (options.message?.trim()) console.log(`  Goal:       ${options.message.trim()}`);
  console.log();

  // Make sure the brain vault exists (swamr init normally does this).
  initBrain(projectDir);

  if (options.message?.trim()) {
    writeUserContext(projectDir, options.message.trim());
    info(`Goal saved to swamr/brain/03-build/user-context.md`);
  }

  const existing = loadState(projectDir);
  if (existing && existing.tasks.some((t) => t.status !== "completed")) {
    warn("An existing swamr/state.json with unfinished tasks was found.");
    warn("Use `swamr continue` to resume that plan. `adopt` creates a NEW plan for the remaining work and will overwrite state.json.");
  }

  // MCP preflight before any agent runs (avoids the silent F2 hang).
  const pre = preflightMcp(projectDir, config);
  if (!pre.ok) {
    header("🙋 Manual step needed before the swarm can start");
    console.log();
    console.log("  These MCP servers aren't ready — agents would hang waiting on them:");
    for (const s of pre.notReady) console.log(`    • ${bold(s.name)} — ${s.status}`);
    console.log();
    console.log("  To fix, authenticate/approve each one:");
    for (const s of pre.notReady) console.log(`    cursor agent mcp login ${s.name}`);
    console.log();
    console.log(`  Then re-run:  ${bold("swamr adopt")}`);
    console.log();
    process.exit(1);
  }

  // ── Discovery: inventory the existing repo ──────────────────────────────────
  header("Discovery: inventorying the existing project");
  const discoverySpinner = new Spinner();
  discoverySpinner.start("Scanning the repository");
  const discoveryPrompt = `You are the Swamr discovery agent. Adopt the @codebase-onboarding-engineer persona (read .cursor/rules/codebase-onboarding-engineer.mdc; if missing, use the closest match).

Inventory THIS existing repository. Do NOT write application code.

Read package.json, the directory tree, routes/screens/components, server code, database migrations, tests, and any existing swamr/brain notes.

Write swamr/brain/00-project/existing-state.md documenting (use [[wikilinks]] where useful):
- Tech stack and how the app runs (dev server, build, test commands)
- Features / screens / APIs that already EXIST and appear to work
- What is incomplete, stubbed, or missing
- Known issues, TODOs, and risky areas
- How to run the test suite${options.message?.trim() ? `\n\nThe user wants to build out: ${options.message.trim()}. Pay special attention to what is needed for that.` : ""}

Be concrete and specific — the planners rely entirely on this note.`;
  await runCursorAgent(projectDir, discoveryPrompt, plannerModel, trust);
  discoverySpinner.stop("Existing state documented");

  // ── Plan only the remaining work ────────────────────────────────────────────
  header("Phase 1: Hierarchical Planning (remaining work)");
  const description = options.message?.trim()
    ? `Finish this existing project: ${options.message.trim()}`
    : "Finish, test, and harden this existing project (see existing-state.md)";

  const rawTasks = await runHierarchicalPlanning(projectDir, description, config, plannerModel, trust, {
    adopt: true,
    message: options.message,
  });

  if (rawTasks.length === 0) {
    console.error("❌ Planning produced no tasks.");
    process.exit(1);
  }

  const tasks: TaskDef[] = rawTasks.map((t: any) => ({
    ...t,
    status: "pending" as const,
    attempts: 0,
  }));

  const state: SwamrState = {
    project: description.slice(0, 100),
    status: "building",
    current_phase: "foundation",
    started_at: new Date().toISOString(),
    tasks,
    phase_waves: {},
    last_checkpoint: null,
    checkpoint_pending: false,
  };
  saveState(projectDir, state);
  reindexBrain(projectDir, state);
  info(`Adoption plan created with ${tasks.length} remaining tasks`);

  await executeBuild(projectDir, state, config, workerModel, trust);
}
