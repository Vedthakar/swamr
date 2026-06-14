import fs from "node:fs";
import path from "node:path";
import { spawn, ChildProcess } from "node:child_process";
import { info, warn, header, bold, writeFileDeep, runSafe, Spinner, ProgressDashboard, ProgressTask } from "./utils.js";

interface TaskDef {
  id: string;
  phase: string;
  description: string;
  agent: string;
  prompt: string;
  depends_on: string[];
  status: "pending" | "in_progress" | "completed" | "failed" | "blocked";
  attempts: number;
  output?: string;
}

interface SwamrState {
  project: string;
  status: string;
  current_phase: string;
  started_at: string;
  tasks: TaskDef[];
}

interface SwamrConfig {
  max_parallel_agents: number;
  max_retries_per_task: number;
  wave_size: number;
  verify_wave_size: number;
  checkpoint_between_waves: boolean;
  required_mcps: string[] | null;
}

interface Blocker {
  task_id: string;
  title: string;
  what_i_need: string;
  why?: string;
  steps?: string[];
}

// Phases where we run smaller waves and force a verification checkpoint between them.
const VERIFY_PHASES = new Set(["testing", "hardening"]);

// Output patterns that signal an agent is stuck on something only a human can do.
const MANUAL_STEP_PATTERNS: RegExp[] = [
  /needs approval/i,
  /not authenticated/i,
  /requires? (?:an? )?api[ _-]?key/i,
  /\bmcp\b[^.\n]*\b(login|auth)/i,
  /please (?:authenticate|log ?in|sign ?in|approve)/i,
  /awaiting (?:user|human|manual)/i,
];

function loadConfig(projectDir: string): SwamrConfig {
  const configPath = path.join(projectDir, "swamr", "config.json");
  let raw: any = {};
  if (fs.existsSync(configPath)) {
    raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  }
  const maxParallel = raw.max_parallel_agents ?? 8;
  return {
    max_parallel_agents: maxParallel,
    max_retries_per_task: raw.max_retries_per_task ?? 3,
    wave_size: Math.min(raw.wave_size ?? 8, maxParallel),
    verify_wave_size: Math.min(raw.verify_wave_size ?? 6, maxParallel),
    checkpoint_between_waves: raw.checkpoint_between_waves ?? true,
    required_mcps: Array.isArray(raw.required_mcps) ? raw.required_mcps : null,
  };
}

function loadState(projectDir: string): SwamrState | null {
  const statePath = path.join(projectDir, "swamr", "state.json");
  if (fs.existsSync(statePath)) {
    return JSON.parse(fs.readFileSync(statePath, "utf-8"));
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

const MCP_NOT_READY = /not loaded|needs approval|not authenticated|unauthor|error/i;

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

function readBlocker(projectDir: string, taskId: string): Blocker | null {
  const fp = path.join(blockersDir(projectDir), `${taskId}.json`);
  if (!fs.existsSync(fp)) return null;
  try {
    const b = JSON.parse(fs.readFileSync(fp, "utf-8"));
    return { task_id: taskId, title: b.title ?? taskId, ...b };
  } catch {
    return { task_id: taskId, title: taskId, what_i_need: "See agent output." };
  }
}

function writeBlocker(projectDir: string, blocker: Blocker) {
  writeFileDeep(
    path.join(blockersDir(projectDir), `${blocker.task_id}.json`),
    JSON.stringify(blocker, null, 2)
  );
}

// Infer a blocker from agent output when the worker didn't write one itself.
function detectManualStep(output: string, task: TaskDef): Blocker | null {
  if (!MANUAL_STEP_PATTERNS.some((re) => re.test(output))) return null;
  return {
    task_id: task.id,
    title: task.description,
    what_i_need:
      "A manual step (auth, API key, account, or GUI action) appears to be required.",
    why: "The agent's output indicates it is waiting on something only you can do.",
    steps: [
      "If an MCP server needs auth, run: cursor agent mcp login <server>",
      "If an API key/secret is needed, add it to .env.local",
      "Then re-run: swamr build --resume",
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

These tasks are paused waiting on a manual step only you can do. Resolve them, then run \`swamr build --resume\`.

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
  console.log(`  After resolving, run: swamr build --resume\n`);
}

function buildBrainContext(projectDir: string): string {
  const brainDir = path.join(projectDir, "swamr", "brain");
  const files = [
    "00-project/overview.md",
    "00-project/architecture.md",
    "00-project/tech-stack.md",
  ];
  let context = "";
  for (const f of files) {
    const fp = path.join(brainDir, f);
    if (fs.existsSync(fp)) {
      context += `\n--- ${f} ---\n${fs.readFileSync(fp, "utf-8")}\n`;
    }
  }
  return context;
}

function runCursorAgent(
  projectDir: string,
  prompt: string,
  model: string = "sonnet-4",
  trust: boolean = false
): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve) => {
    const args = [
      "agent",
      "--print",
      "--output-format", "text",
      "--force",
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

    child.on("close", (code) => {
      resolve({
        success: code === 0,
        output: output || errorOutput,
      });
    });

    child.on("error", (err) => {
      resolve({
        success: false,
        output: `Failed to spawn cursor agent: ${err.message}`,
      });
    });

    // 10 minute timeout per agent
    setTimeout(() => {
      child.kill("SIGTERM");
      resolve({
        success: false,
        output: output + "\n[TIMEOUT: agent killed after 10 minutes]",
      });
    }, 10 * 60 * 1000);
  });
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
  let brainContext = buildBrainContext(projectDir);

  // pending = anything still actionable. Blocked tasks are intentionally excluded
  // (they wait on a human) so we never burn retries on them.
  let pending = tasks.filter((t) => t.status === "pending" || t.status === "failed");
  let wave = 0;

  while (pending.length > 0) {
    const ready = pending.filter((t) =>
      t.depends_on.every((dep) => {
        const depTask = state.tasks.find((st) => st.id === dep);
        return depTask?.status === "completed";
      })
    );

    if (ready.length === 0) {
      // Nothing can run: either a real deadlock or everything left is blocked on a human.
      const blockedDeps = pending.filter((t) =>
        t.depends_on.some((dep) => {
          const depTask = state.tasks.find((st) => st.id === dep);
          return depTask?.status === "blocked";
        })
      );
      if (blockedDeps.length > 0) {
        warn(`${blockedDeps.length} task(s) waiting on blocked dependencies — see swamr/NEEDS-YOU.md`);
      } else {
        warn("No tasks ready — possible dependency deadlock");
      }
      break;
    }

    wave++;
    const batch = ready.slice(0, Math.max(1, opts.waveSize));
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

      const fullPrompt = buildTaskPrompt(task, brainContext, projectDir);
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

      // Write task output to brain
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
${result.output.slice(-2000)}
`
      );

      saveState(projectDir, state);
    });

    await Promise.all(promises);

    // Surface any new manual-step blockers immediately (non-blocking: other waves continue).
    const blockers = collectBlockers(projectDir, state);
    writeNeedsYou(projectDir, blockers);
    if (dashboard) dashboard.blockedCount = blockers.length;

    // Remove tasks that are done for this run (completed/failed/blocked) from pending.
    pending = pending.filter(
      (t) => t.status === "pending" || t.status === "failed"
    );

    // Re-evaluation checkpoint between waves: a single agent assesses progress,
    // flags stuck/duplicate work, and may split large tasks into subtasks.
    if (opts.runCheckpoint && pending.length > 0) {
      if (dashboard) dashboard.checkpoint = true;
      await runCheckpointAgent(projectDir, state, wave, opts.phase, model, trust);
      mergeNewTasks(projectDir, state, opts.phase, pending);
      if (dashboard) dashboard.checkpoint = false;
      brainContext = buildBrainContext(projectDir);
    }
  }
}

// One agent re-evaluates "where are we at" between waves and writes a checkpoint note.
async function runCheckpointAgent(
  projectDir: string,
  state: SwamrState,
  wave: number,
  phase: string,
  model: string,
  trust: boolean
): Promise<void> {
  const completed = state.tasks.filter((t) => t.status === "completed").length;
  const blocked = state.tasks.filter((t) => t.status === "blocked").length;
  const failed = state.tasks.filter((t) => t.status === "failed").length;
  const remaining = state.tasks.filter(
    (t) => t.status === "pending" || t.status === "failed"
  ).length;

  const prompt = `You are the Swamr re-evaluation checkpoint (use the @reality-checker persona). Wave ${wave} of the "${phase}" phase just finished.

Current tally: ${completed} completed, ${remaining} remaining, ${blocked} blocked (waiting on a human), ${failed} failed.

Do the following, then STOP. Do NOT write application code.
1. Read swamr/state.json and the Obsidian brain (swamr/brain/, especially 03-build/task-outputs/).
2. Assess progress: what is actually done vs claimed, any duplicated/conflicting work, and any task that is stuck making no real progress.
3. Write a concise checkpoint note to swamr/brain/03-build/checkpoints/wave-${wave}.md with: progress summary, risks, and recommended next actions.
4. ONLY if a remaining task is too large or is stuck, split it: APPEND new smaller task objects to swamr/tasks.json using the SAME schema { "id", "phase", "description", "agent", "prompt", "depends_on" }. Use new unique ids (e.g. "${phase[0].toUpperCase()}${wave}a"). Set "phase" to "${phase}". Do NOT modify or remove existing tasks.

Keep it brief and decisive.`;

  await runCursorAgent(projectDir, prompt, model, trust);
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
  let added = 0;
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
    if (newTask.phase === phase) pending.push(newTask);
    added++;
  }
  if (added > 0) {
    info(`Checkpoint split work into ${added} new subtask(s)`);
    saveState(projectDir, state);
  }
}

function buildTaskPrompt(task: TaskDef, brainContext: string, projectDir: string): string {
  const planPath = path.join(projectDir, "swamr", "plan.md");
  const plan = fs.existsSync(planPath) ? fs.readFileSync(planPath, "utf-8") : "";

  return `You are working as part of the Swamr agent swarm.

Your assigned role: @${task.agent}
Your task (${task.id}): ${task.description}

INSTRUCTIONS:
${task.prompt}

PROJECT CONTEXT (from Obsidian brain):
${brainContext}

PROJECT PLAN:
${plan.slice(0, 3000)}

RULES:
1. Complete ONLY your assigned task — do not work on other tasks
2. Write production-quality code with proper TypeScript types
3. After completing your work, write a brief summary of what you did
4. If you find issues or make architecture decisions, note them clearly
5. Do NOT modify swamr/ or .cursor/ directories (the one exception is the blocker file described below)
6. Handle errors gracefully — no unhandled promise rejections
7. Follow existing code patterns and naming conventions in the project

MANUAL-STEP / BLOCKER PROTOCOL (IMPORTANT):
If you cannot finish because of something only a human can do — authenticating an MCP server,
providing an API key or secret, creating or upgrading an account, billing, or clicking through a
web GUI — do NOT keep retrying, wait, or fake the result. Instead:
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

export async function build(
  targetDir: string,
  description: string,
  options: { model?: string; plan_only?: boolean; trust?: boolean } = {}
) {
  const projectDir = path.resolve(targetDir);
  const config = loadConfig(projectDir);
  const plannerModel = options.model ?? "sonnet-4";
  const workerModel = "sonnet-4";
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
    console.log(`  Then re-run:  ${bold("swamr build --resume")}`);
    console.log();
    process.exit(1);
  }

  header("🐝 Swamr — Multi-Agent Build");
  console.log(`  Project:    ${projectDir}`);
  console.log(`  Workers:    up to ${config.max_parallel_agents} parallel agents`);
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
    // --- PHASE 1: PLANNING ---
    header("Phase 1: Planning (using orchestrator agent)");
    const planSpinner = new Spinner();
    planSpinner.start("Planning your project");

    const planPrompt = `You are the Swamr Orchestrator. Read the rules at .cursor/rules/swamr-orchestrator.mdc and .cursor/rules/swamr-planner.mdc.

The user wants to build: ${description}

Do the following:
1. Write the project overview to swamr/brain/00-project/overview.md
2. Write the tech stack to swamr/brain/00-project/tech-stack.md
3. Write the architecture to swamr/brain/00-project/architecture.md
4. Write a detailed project plan to swamr/plan.md with ALL tasks broken down

5. MOST IMPORTANTLY: Write a machine-readable task list to swamr/tasks.json with this EXACT format:
[
  {
    "id": "F1",
    "phase": "foundation",
    "description": "Scaffold the project with Next.js/Expo",
    "agent": "devops-automator",
    "prompt": "Detailed instructions for what to build...",
    "depends_on": []
  },
  {
    "id": "F2",
    "phase": "foundation",
    "description": "Design and create database schema",
    "agent": "database-optimizer",
    "prompt": "Create the Supabase schema with these tables...",
    "depends_on": []
  },
  {
    "id": "B1",
    "phase": "build",
    "description": "Build the dashboard page",
    "agent": "frontend-developer",
    "prompt": "Build a responsive dashboard page at app/(tabs)/index.tsx...",
    "depends_on": ["F1", "F2"]
  }
]

Include tasks for ALL phases:
- Foundation (F1-F6): scaffold, database, auth, config, design system
- Build (B1-B20): ALL features, one task per screen/component/API
- Testing (T1-T5): unit tests, integration tests, E2E tests
- Hardening (H1-H4): security audit, performance, accessibility, legal compliance
- Launch (L1-L3): documentation, deployment, final validation

Each task MUST have a detailed "prompt" field with specific instructions.
Assign the right agent slug from the .cursor/rules/ files.
Make the dependency graph correct — nothing starts before its dependencies.

SPLIT AGGRESSIVELY. Each task should be a single, narrowly-scoped unit of work that one agent
can finish in a single focused session (one screen, one API route, one table/migration, one
component, one test suite). Prefer many small tasks over a few large ones — this lets the swarm
run far more agents in parallel across waves. Maximize independent tasks (empty depends_on) so
each wave is wide. Create 40-80 tasks; more is better as long as each is genuinely distinct.`;

    const planResult = await runCursorAgent(projectDir, planPrompt, plannerModel, trust);

    if (!planResult.success) {
      planSpinner.stop();
      console.error("❌ Planning failed. Output:");
      console.error(planResult.output);
      process.exit(1);
    }
    planSpinner.stop("Planning complete");

    // Parse tasks.json
    const tasksPath = path.join(projectDir, "swamr", "tasks.json");
    if (!fs.existsSync(tasksPath)) {
      console.error("❌ Planner did not create swamr/tasks.json");
      console.error("The planning agent needs to write a tasks.json file.");
      process.exit(1);
    }

    const rawTasks = JSON.parse(fs.readFileSync(tasksPath, "utf-8"));
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
    };
    saveState(projectDir, state);
    info(`Plan created with ${tasks.length} tasks`);

    if (options.plan_only) {
      header("✅ Plan created. Review swamr/plan.md and swamr/tasks.json");
      console.log("Run 'swamr build --resume' to execute the plan.");
      return;
    }
  }

  // --- PHASE 2+: EXECUTE TASKS BY PHASE ---
  const phases = ["foundation", "build", "testing", "hardening", "launch"];
  const totalTasks = state!.tasks.length;
  const alreadyDone = state!.tasks.filter((t) => t.status === "completed").length;

  const dashboard = new ProgressDashboard();
  dashboard.totalPhases = phases.filter((p) => state!.tasks.some((t) => t.phase === p)).length;
  dashboard.overallTotal = totalTasks;
  dashboard.overallCompleted = alreadyDone;
  dashboard.start();

  let phaseCounter = 0;

  for (const phase of phases) {
    const phaseTasks = state!.tasks.filter((t) => t.phase === phase);
    if (phaseTasks.length === 0) continue;

    const allDone = phaseTasks.every((t) => t.status === "completed");
    if (allDone) {
      dashboard.overallCompleted += phaseTasks.length;
      continue;
    }

    phaseCounter++;
    state!.current_phase = phase;

    dashboard.phase = phase;
    dashboard.phaseIndex = phaseCounter;
    dashboard.phaseCompleted = phaseTasks.filter((t) => t.status === "completed").length;
    dashboard.phaseTotal = phaseTasks.length;
    dashboard.activeTasks = [];

    // Verification phases run smaller waves and always check between them.
    const verify = VERIFY_PHASES.has(phase);
    const waveSize = verify ? config.verify_wave_size : config.wave_size;
    const runCheckpoint = verify ? true : config.checkpoint_between_waves;

    await runTaskBatch(projectDir, phaseTasks, state!, config, workerModel, trust, dashboard, {
      waveSize,
      runCheckpoint,
      phase,
    });

    // Write phase summary to brain
    const completed = phaseTasks.filter((t) => t.status === "completed").length;
    const failed = phaseTasks.filter((t) => t.status === "failed").length;

    writeFileDeep(
      path.join(projectDir, "swamr", "brain", `0${phases.indexOf(phase) + 2}-${phase}`, "phase-summary.md"),
      `---
phase: ${phase}
completed: ${new Date().toISOString()}
tasks_completed: ${completed}
tasks_failed: ${failed}
---

# Phase Summary: ${phase}

## Results
- Tasks completed: ${completed}/${phaseTasks.length}
- Tasks failed: ${failed}/${phaseTasks.length}

## Completed Tasks
${phaseTasks
  .filter((t) => t.status === "completed")
  .map((t) => `- ${t.id}: ${t.description}`)
  .join("\n")}

${failed > 0 ? `## Failed Tasks\n${phaseTasks.filter((t) => t.status === "failed").map((t) => `- ${t.id}: ${t.description}`).join("\n")}` : ""}
`
    );

    saveState(projectDir, state!);

    if (failed > 0) {
      dashboard.stop();
      warn(`Phase "${phase}" had ${failed} failed tasks`);
      dashboard.start();
    }
  }

  dashboard.stop();

  // --- DONE ---
  const totalCompleted = state!.tasks.filter((t) => t.status === "completed").length;
  const totalFailed = state!.tasks.filter((t) => t.status === "failed").length;
  const blockers = collectBlockers(projectDir, state!);
  writeNeedsYou(projectDir, blockers);

  state!.status =
    blockers.length > 0
      ? "blocked"
      : totalFailed === 0
        ? "completed"
        : "completed_with_errors";
  saveState(projectDir, state!);

  console.log();
  header("🐝 Swamr Build Complete!");
  console.log();
  console.log(`  Tasks completed: ${totalCompleted}/${state!.tasks.length}`);
  console.log(`  Tasks failed:    ${totalFailed}`);
  console.log(`  Tasks blocked:   ${blockers.length}`);
  console.log(`  Brain notes:     swamr/brain/`);
  console.log(`  State:           swamr/state.json`);
  console.log();

  printNeedsYou(blockers);
}
