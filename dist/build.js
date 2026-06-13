import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { info, warn, header, writeFileDeep, runSafe, Spinner } from "./utils.js";
function loadConfig(projectDir) {
    const configPath = path.join(projectDir, "swamr", "config.json");
    if (fs.existsSync(configPath)) {
        const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        return {
            max_parallel_agents: raw.max_parallel_agents ?? 8,
            max_retries_per_task: raw.max_retries_per_task ?? 3,
        };
    }
    return { max_parallel_agents: 8, max_retries_per_task: 3 };
}
function loadState(projectDir) {
    const statePath = path.join(projectDir, "swamr", "state.json");
    if (fs.existsSync(statePath)) {
        return JSON.parse(fs.readFileSync(statePath, "utf-8"));
    }
    return null;
}
function saveState(projectDir, state) {
    writeFileDeep(path.join(projectDir, "swamr", "state.json"), JSON.stringify(state, null, 2));
}
function buildBrainContext(projectDir) {
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
function runCursorAgent(projectDir, prompt, model = "sonnet-4", trust = false) {
    return new Promise((resolve) => {
        const args = [
            "agent",
            "--print",
            "--output-format", "text",
            "--force",
            ...(trust ? ["--trust"] : []),
            "--workspace", projectDir,
            "--model", model,
            prompt,
        ];
        let output = "";
        let errorOutput = "";
        const child = spawn("cursor", args, {
            cwd: projectDir,
            env: { ...process.env },
            stdio: ["pipe", "pipe", "pipe"],
        });
        child.stdout?.on("data", (data) => {
            const text = data.toString();
            output += text;
            process.stdout.write(text);
        });
        child.stderr?.on("data", (data) => {
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
async function runTaskBatch(projectDir, tasks, state, config, model, trust = false) {
    const brainContext = buildBrainContext(projectDir);
    // Run tasks in batches up to max_parallel_agents
    const pending = tasks.filter((t) => t.status === "pending" || t.status === "failed");
    while (pending.length > 0) {
        // Find tasks whose dependencies are all completed
        const ready = pending.filter((t) => t.depends_on.every((dep) => {
            const depTask = state.tasks.find((st) => st.id === dep);
            return depTask?.status === "completed";
        }));
        if (ready.length === 0) {
            warn("No tasks ready — possible dependency deadlock");
            break;
        }
        const batch = ready.slice(0, config.max_parallel_agents);
        header(`Running batch of ${batch.length} agents in parallel...`);
        for (const t of batch) {
            console.log(`  → ${t.id}: ${t.description} (agent: @${t.agent})`);
        }
        const promises = batch.map(async (task) => {
            task.status = "in_progress";
            task.attempts++;
            saveState(projectDir, state);
            const fullPrompt = buildTaskPrompt(task, brainContext, projectDir);
            const spinner = new Spinner();
            spinner.start(`[${task.id}] ${task.description}`);
            const result = await runCursorAgent(projectDir, fullPrompt, model, trust);
            if (result.success) {
                task.status = "completed";
                task.output = result.output.slice(-500);
                spinner.stop(`[${task.id}] Completed: ${task.description}`);
            }
            else {
                if (task.attempts >= config.max_retries_per_task) {
                    task.status = "failed";
                    spinner.stop();
                    warn(`[${task.id}] Failed after ${task.attempts} attempts`);
                }
                else {
                    task.status = "pending";
                    spinner.stop();
                    warn(`[${task.id}] Failed (attempt ${task.attempts}/${config.max_retries_per_task}), will retry`);
                }
            }
            // Write task output to brain
            writeFileDeep(path.join(projectDir, "swamr", "brain", "03-build", "task-outputs", `${task.id}.md`), `---
task_id: ${task.id}
agent: ${task.agent}
status: ${task.status}
attempts: ${task.attempts}
date: ${new Date().toISOString()}
---

# ${task.description}

## Agent Output
${result.output.slice(-2000)}
`);
            saveState(projectDir, state);
        });
        await Promise.all(promises);
        // Remove completed/failed tasks from pending list
        for (let i = pending.length - 1; i >= 0; i--) {
            if (pending[i].status === "completed" || pending[i].status === "failed") {
                pending.splice(i, 1);
            }
        }
    }
}
function buildTaskPrompt(task, brainContext, projectDir) {
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
5. Do NOT modify swamr/ or .cursor/ directories
6. Handle errors gracefully — no unhandled promise rejections
7. Follow existing code patterns and naming conventions in the project

${task.attempts > 1 ? `\nNOTE: This is retry attempt ${task.attempts}. Previous attempt failed. Make sure to check for existing files before creating new ones, and fix any issues from the previous attempt.\n` : ""}

Begin working now. Complete the task fully.`;
}
export async function build(targetDir, description, options = {}) {
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
    }
    else {
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

Create 25-40 tasks minimum. This should be a THOROUGH decomposition.`;
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
        const tasks = rawTasks.map((t) => ({
            ...t,
            status: "pending",
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
    for (const phase of phases) {
        const phaseTasks = state.tasks.filter((t) => t.phase === phase);
        if (phaseTasks.length === 0)
            continue;
        const allDone = phaseTasks.every((t) => t.status === "completed");
        if (allDone) {
            info(`Phase "${phase}" already complete, skipping`);
            continue;
        }
        state.current_phase = phase;
        header(`Phase: ${phase.toUpperCase()} (${phaseTasks.length} tasks)`);
        await runTaskBatch(projectDir, phaseTasks, state, config, workerModel, trust);
        // Write phase summary to brain
        const completed = phaseTasks.filter((t) => t.status === "completed").length;
        const failed = phaseTasks.filter((t) => t.status === "failed").length;
        writeFileDeep(path.join(projectDir, "swamr", "brain", `0${phases.indexOf(phase) + 2}-${phase}`, "phase-summary.md"), `---
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
`);
        saveState(projectDir, state);
        if (failed > 0) {
            warn(`Phase "${phase}" had ${failed} failed tasks`);
        }
    }
    // --- DONE ---
    const totalCompleted = state.tasks.filter((t) => t.status === "completed").length;
    const totalFailed = state.tasks.filter((t) => t.status === "failed").length;
    state.status = totalFailed === 0 ? "completed" : "completed_with_errors";
    saveState(projectDir, state);
    console.log();
    header("🐝 Swamr Build Complete!");
    console.log();
    console.log(`  Tasks completed: ${totalCompleted}/${state.tasks.length}`);
    console.log(`  Tasks failed:    ${totalFailed}`);
    console.log(`  Brain notes:     swamr/brain/`);
    console.log(`  State:           swamr/state.json`);
    console.log();
}
