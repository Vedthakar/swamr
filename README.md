<div align="center">

<img src="https://raw.githubusercontent.com/Vedthakar/swamr/main/assets/cover.png" alt="swamr — agent swarm for Cursor" width="100%" />

<br />

# swamr

**Deploy 150+ specialist AI agents that plan, build, test, harden, and ship your entire project — autonomously.**

Drop swamr into any project (new or existing), describe what you want, and a swarm of parallel Cursor agents handles the rest. An Obsidian vault tracks every decision so no context is ever lost between agents.

<br />

[![npm version](https://img.shields.io/badge/swamr-v1.4.0-yellow?style=for-the-badge)](https://github.com/Vedthakar/swamr)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)](LICENSE)
[![Requires Cursor](https://img.shields.io/badge/Requires-Cursor-purple?style=for-the-badge)](https://cursor.com)
[![Node 18+](https://img.shields.io/badge/Node-18%2B-green?style=for-the-badge)](https://nodejs.org)
[![Agency Agents](https://img.shields.io/badge/Powered%20by-Agency%20Agents-orange?style=for-the-badge)](https://github.com/msitarzewski/agency-agents)

</div>

---

## What is swamr?

Most AI coding tools run one agent at a time. swamr runs **up to 8 specialist agents in parallel**, each owning a specific task, all sharing a structured Obsidian vault so they never lose context between phases.

```
You type one prompt.
swamr spawns a planner → 25-40 tasks → parallel specialist agents → production-ready code.
```

It supports **four modes**:

| Mode | Command | Best For |
|------|---------|----------|
| **Build** | `swamr build "..."` | New projects from scratch |
| **Adopt** | `swamr adopt -m "..."` | Existing codebases — picks up from wherever you are |
| **Continue** | `swamr continue` | Resume after interruption or partial completion |
| **Single-agent** | `@swamr-orchestrator` in Cursor chat | Quick tasks, no terminal needed |

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [All Commands](#all-commands)
- [How It Works](#how-it-works)
- [The Obsidian Brain](#the-obsidian-brain)
- [The 150+ Agent Roster](#the-150-agent-roster)
- [Supabase Setup](#supabase-setup)
- [MCP Integration](#mcp-integration)
- [Configuration](#configuration)
- [Adding Custom Agents](#adding-custom-agents)
- [Restarting from Scratch](#restarting-from-scratch)
- [Troubleshooting](#troubleshooting)
- [Credits](#credits)

---

## Prerequisites

| Tool | Required | Why | Install |
|------|----------|-----|---------|
| **Cursor** | ✅ Yes | The IDE that runs the agents | [cursor.com](https://cursor.com) — Pro plan recommended |
| **Cursor CLI** | ✅ Yes (for CLI mode) | Spawns parallel agent processes | Bundled with Cursor. Run `cursor agent login` once. |
| **Node.js 18+** | ✅ Yes | Runs the swamr CLI | [nodejs.org](https://nodejs.org) |
| **Git** | ✅ Yes | Version control for your project | Pre-installed on most systems |
| **Obsidian** | ⭐ Recommended | View the agent brain vault live | [obsidian.md](https://obsidian.md) — free |
| **Playwright** | Optional | Browser automation tasks | `npx playwright install` |

> **Cursor Pro note:** The free tier has usage limits. With 8 agents running in parallel, you'll hit them fast. Pro ($20/mo) is effectively required for serious use.

---

## Installation

Run these commands **once** on your machine. After this, swamr is available globally as the `swamr` command.

```bash
# 1. Clone swamr to your home directory
git clone https://github.com/Vedthakar/swamr.git ~/swamr

# 2. Install dependencies and build the CLI
cd ~/swamr
npm install

# 3. Link the CLI globally so 'swamr' works from anywhere
npm link
```

Verify installation:

```bash
swamr --help
```

You should see the swamr help menu listing `init`, `build`, `continue`, and `adopt`.

> **Node version managers (nvm/fnm):** `npm link` ties `swamr` to whichever Node version is active when you run it. If you switch Node versions later, `cd ~/swamr && npm link` again.

---

## Quick Start

### New project from scratch

```bash
# Step 1: Create and initialize a new project
swamr init ./my-app

# Step 2: Authenticate Cursor CLI (one-time)
cursor agent login

# Step 3: Build it
swamr build --dir ./my-app --trust \
  "A SaaS dashboard with Supabase auth, billing via Stripe, team management, and a REST API"
```

That's it. Watch the terminal — agents will appear, work in parallel, and write their outputs to `my-app/swamr/brain/`.

### Existing project (adopt mode)

```bash
# Step 1: Initialize swamr rules in your existing project
cd ./my-existing-app
swamr init

# Step 2: Tell swamr what's there and what to finish
swamr adopt --dir . --trust \
  -m "This is a Next.js app with auth and a home page. Finish the dashboard, add billing with Stripe, and write tests."
```

swamr will first run a **discovery agent** that reads your codebase, then plan only the remaining work.

---

## All Commands

### `swamr init [dir]`

Initializes swamr in a project directory. Run this **once per project** before building.

```bash
swamr init              # Initialize in current directory
swamr init ./my-app     # Initialize in a specific directory
```

**What it does:**
- Clones 150+ agent skill definitions from [agency-agents](https://github.com/msitarzewski/agency-agents)
- Converts them to Cursor `.mdc` rule files in `.cursor/rules/`
- Installs the orchestrator, planner, QA loop, state manager, and brain system
- Creates the `swamr/brain/` Obsidian vault with templates
- Sets up `.gitignore` to protect state and evidence files

**Where to run it:** From anywhere. Pass the project path as an argument, or `cd` into the project first.

---

### `swamr build [options] "description"`

Builds a project from scratch using parallel agents.

```bash
swamr build --dir ./my-app --trust "description of what to build"
```

| Option | Default | Description |
|--------|---------|-------------|
| `--dir <path>` | Current directory | The project to build in |
| `--model <model>` | Auto | LLM model for agents |
| `--plan-only` | false | Generate the plan but don't execute yet |
| `--resume` | false | Resume from existing `swamr/state.json` |
| `--trust` | false | Auto-approve all agent commands (no prompts) |

**Examples:**

```bash
# Build with auto-approval (recommended for unattended runs)
swamr build --dir ./my-app --trust \
  "A habit tracking app with streaks, social accountability, and push notifications"

# Plan first, review, then execute
swamr build --dir ./my-app --plan-only "An e-commerce store with Stripe payments"
# Review swamr/plan.md and swamr/tasks.json, make edits, then:
swamr build --dir ./my-app --trust --resume

# Resume a build that was interrupted
swamr build --dir ./my-app --trust --resume
```

---

### `swamr continue [options]`

Resumes a build from `swamr/state.json` without re-planning. Use this when:
- Your build was interrupted (Ctrl+C, crash, timeout)
- Some tasks failed and you want to retry them
- You resolved a blocker and want to pick up from there

```bash
swamr continue --dir ./my-app --trust
```

```bash
# Tell the swarm what changed since last time
swamr continue --dir ./my-app --trust \
  -m "I fixed the database password and added the Stripe key to .env.local"
```

| Option | Description |
|--------|-------------|
| `--dir <path>` | Project directory |
| `--trust` | Auto-approve commands |
| `-m "message"` | Context about what changed — written to the brain |

---

### `swamr adopt [options] -m "message"`

Adopts an **existing codebase** that swamr didn't create. A discovery agent first inventories what's already built, then the swarm plans and builds only the remaining work.

```bash
swamr adopt --dir ./my-existing-project --trust \
  -m "This is a Next.js app with Supabase auth already set up. Build the dashboard, add team management, write tests, and deploy to Vercel."
```

| Option | Description |
|--------|-------------|
| `--dir <path>` | The existing project directory |
| `--trust` | Auto-approve commands |
| `-m "message"` | **Required.** Describe what exists and what to finish. |

> **Run `swamr init` first** if the project doesn't have `.cursor/rules/` yet. The `adopt` command needs the agent rules to be installed.

---

## How It Works

### Phase Architecture

```
swamr build "description"
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│  WAVE 0 — PLANNER  (1 agent, smarter model)             │
│  Reads available agents → decomposes into 25-40 tasks   │
│  Writes: swamr/plan.md + swamr/tasks.json               │
└───────────────────┬─────────────────────────────────────┘
                    │
    ┌───────────────▼──────────────────────────────────────┐
    │  FOUNDATION WAVE  (2-4 agents in parallel)           │
    │  ├── Agent: scaffold project structure               │
    │  ├── Agent: database schema + migrations             │
    │  ├── Agent: authentication system                    │
    │  └── Agent: design system + components              │
    └───────────────┬──────────────────────────────────────┘
                    │
    ┌───────────────▼──────────────────────────────────────┐
    │  BUILD WAVE  (up to 8 agents in parallel)            │
    │  ├── @frontend-developer  → dashboard page           │
    │  ├── @frontend-developer  → settings page           │
    │  ├── @backend-architect   → API routes               │
    │  ├── @ai-engineer         → AI features             │
    │  └── ... (dispatched as dependencies resolve)       │
    └───────────────┬──────────────────────────────────────┘
                    │
    ┌───────────────▼──────────────────────────────────────┐
    │  TEST WAVE  (3-5 agents in parallel)                 │
    │  ├── @api-tester          → API tests                │
    │  ├── @evidence-collector  → integration tests        │
    │  └── @reality-checker     → E2E validation          │
    └───────────────┬──────────────────────────────────────┘
                    │
    ┌───────────────▼──────────────────────────────────────┐
    │  HARDENING WAVE  (4 agents in parallel)              │
    │  ├── @security-architect  → security audit           │
    │  ├── @performance-benchmarker → perf audit           │
    │  ├── @accessibility-auditor   → a11y audit           │
    │  └── @legal-compliance-checker → compliance         │
    └───────────────┬──────────────────────────────────────┘
                    │
    ┌───────────────▼──────────────────────────────────────┐
    │  LAUNCH WAVE  (2-3 agents)                           │
    │  ├── @technical-writer    → docs + README            │
    │  ├── @devops-automator    → deploy                   │
    │  └── @reality-checker     → final validation        │
    └─────────────────────────────────────────────────────┘
```

Each box is a **real separate `cursor agent` process**. They run simultaneously on your machine, sharing the codebase via the filesystem and sharing context via the Obsidian brain vault.

### State & Resume

Every task completion is written to `swamr/state.json`. If the build is interrupted for any reason — crash, timeout, you pressed Ctrl+C, your laptop died — run `swamr continue` and it picks up from the exact task that was in progress.

### Blockers

When an agent hits something it can't do autonomously (needs an API key, a human login, a billing step), it writes a blocker file to `swamr/blockers/<task-id>.json` and stops. The build continues with other tasks. A `NEEDS-YOU.md` file is written to the project root listing everything that needs your attention.

Once you resolve the blocker and delete the file, `swamr continue` requeues the blocked task.

---

## The Obsidian Brain

The brain is what separates swamr from just using Cursor manually. It's a structured vault that agents use as **shared persistent memory** — so the 50th agent has the same context as the 1st.

```
swamr/brain/
├── 00-project/
│   ├── overview.md          ← What we're building and why
│   ├── tech-stack.md        ← Every technology decision and why
│   ├── architecture.md      ← System design and diagrams
│   └── glossary.md          ← Domain-specific terms
│
├── 01-planning/
│   ├── requirements.md      ← Full feature requirements
│   ├── task-tree.md         ← Dependency graph of all tasks
│   ├── risk-register.md     ← Known risks and mitigations
│   └── decisions/           ← Architecture Decision Records (ADRs)
│
├── 02-foundation/           ← Foundation phase outputs
│
├── 03-build/
│   ├── phase-log.md         ← Running timeline of what happened
│   ├── task-outputs/        ← One note per completed task
│   └── issues/              ← Bugs and blockers found during build
│
├── 04-testing/              ← Test plans and results
│
├── 05-hardening/            ← Security, performance, a11y, legal reports
│
├── 06-launch/               ← Deploy runbooks and handoff docs
│
└── templates/               ← Note templates used by agents
```

**Open it in Obsidian** (`File → Open Vault → select swamr/brain/`) and watch notes appear in real time as agents work. Graph view shows how decisions connect. You can edit notes mid-build to steer the agents.

Every agent **reads** the brain before starting its task and **writes** a completion note after finishing. This is non-negotiable — it's enforced in the agent rules.

---

## The 150+ Agent Roster

swamr includes the full [Agency Agents](https://github.com/msitarzewski/agency-agents) roster plus swamr-specific orchestration agents:

| Category | Agents |
|----------|--------|
| **Engineering** | `frontend-developer`, `backend-architect`, `devops-automator`, `ai-engineer`, `database-optimizer`, `mobile-app-builder`, `software-architect`, `data-engineer`, `embedded-firmware-engineer`, `rapid-prototyper` |
| **Testing & QA** | `evidence-collector`, `reality-checker`, `api-tester`, `performance-benchmarker`, `accessibility-auditor`, `model-qa-specialist`, `test-results-analyzer` |
| **Security** | `security-architect`, `application-security-engineer`, `senior-secops-engineer`, `compliance-auditor`, `penetration-tester`, `cloud-security-architect`, `blockchain-security-auditor` |
| **Design & UX** | `ui-designer`, `ux-architect`, `ux-researcher`, `brand-guardian`, `visual-storyteller`, `whimsy-injector` |
| **Product** | `product-manager`, `sprint-prioritizer`, `workflow-architect`, `senior-project-manager`, `game-designer` |
| **Marketing** | `growth-hacker`, `seo-specialist`, `content-creator`, `social-media-strategist`, `email-marketing-strategist`, `tiktok-strategist`, `linkedin-content-creator` |
| **Finance & Legal** | `financial-analyst`, `legal-compliance-checker`, `bookkeeper-controller`, `tax-strategist`, `data-privacy-officer` |
| **Swamr System** | `swamr-orchestrator`, `swamr-planner`, `swamr-skill-selector`, `swamr-qa-loop`, `swamr-state-manager`, `swamr-obsidian-brain` |

The orchestrator automatically picks the right agent for each task based on the task description, tech stack, and what's already been built.

**Use any agent directly** in Cursor chat without running a full build:

```
@frontend-developer Build a responsive data table with sorting and pagination
@security-architect Audit the authentication flow for vulnerabilities
@backend-architect Design the API for real-time collaborative editing
@data-privacy-officer Review this feature for GDPR compliance
```

---

## Supabase Setup

swamr uses **hosted Supabase only** — no Docker, no `supabase start`. Local Supabase was removed because it blocked builds reliably across different machines.

### What you do manually (once per project)

1. Go to [supabase.com/dashboard](https://supabase.com/dashboard) → **New project**
2. Save the database password somewhere safe
3. Go to **Settings → API** and copy:

| Key | Env var name | Used for |
|-----|-------------|---------|
| Project URL | `NEXT_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_URL` | Frontend + backend |
| `anon` public key | `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Frontend (safe to expose) |
| `service_role` key | `SUPABASE_SERVICE_ROLE_KEY` | Backend only — **never ship to frontend** |

4. Add these to `.env.local` in your project root

### What the agents handle automatically

Once keys are in `.env.local`, the agents use the **Supabase MCP** or the Supabase CLI to:
- Link the project (`supabase link`)
- Apply migrations (`supabase db push`)
- Enable extensions (PostGIS, pgvector, etc.)
- Create tables, RLS policies, indexes, and seed data
- Generate TypeScript types (`supabase gen types typescript`)
- Run connection tests

**If keys are missing:** agents write `swamr/blockers/F2.json` and continue other tasks. You'll see it in `NEEDS-YOU.md`. Add the keys and run `swamr continue`.

---

## MCP Integration

If you have MCP servers configured in Cursor, agents detect and use them automatically:

| MCP Server | What agents use it for |
|-----------|----------------------|
| **Supabase** | Database operations, migrations, edge functions, type generation |
| **Vercel** | Deployments, environment variable management |
| **GitHub** | Repo operations, PR management, branch creation |
| **Slack** | Build progress notifications |
| Any other | Detected from your Cursor MCP config and used when relevant |

No configuration needed — agents read your Cursor MCP settings and adapt.

---

## Configuration

Edit `swamr/config.json` to customize build behavior:

```json
{
  "max_parallel_agents": 8,
  "max_retries_per_task": 3,
  "quality_gates": true,
  "browser_automation": true,
  "wave_size": 8,
  "verify_wave_size": 4,
  "phases": [
    "discovery",
    "planning",
    "foundation",
    "build",
    "test",
    "harden",
    "launch"
  ]
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `max_parallel_agents` | `8` | Max concurrent agent processes |
| `max_retries_per_task` | `3` | How many times to retry a failed task |
| `quality_gates` | `true` | Run QA validation after each task |
| `wave_size` | `8` | Agents per build wave |
| `verify_wave_size` | `4` | Agents per verification wave |

---

## Adding Custom Agents

Create a `.mdc` file in your project's `.cursor/rules/` directory:

```bash
touch .cursor/rules/my-specialist.mdc
```

Paste this template and fill it in:

```yaml
---
description: "My specialist — one sentence describing what it does"
globs: ""
alwaysApply: false
---

# My Specialist

You are **My Specialist**, an expert in [domain].

## Your Mission
[What this agent should accomplish]

## How You Work
[Step-by-step behavior]

## Rules
- [Rule 1]
- [Rule 2]
```

Use it in Cursor chat: `@my-specialist Do the thing`

Or reference it in the swamr orchestrator prompt:
```
@swamr-orchestrator Build a payment system using @my-specialist for the payment logic
```

---

## Restarting from Scratch

**If you want to completely reset a build and start over:**

```bash
# 1. Delete all swamr state (keeps your code)
rm -rf ./my-app/swamr/state.json
rm -rf ./my-app/swamr/brain/
rm -rf ./my-app/swamr/evidence/
rm -rf ./my-app/swamr/blockers/

# 2. Optionally delete generated code too
rm -rf ./my-app/src/
rm -rf ./my-app/dist/

# 3. Re-init and rebuild
swamr init ./my-app
swamr build --dir ./my-app --trust "your description"
```

**If you just want to retry failed tasks (not start over):**

```bash
swamr continue --dir ./my-app --trust
```

**If agents are stuck or frozen:**

```bash
# Kill all running cursor agent processes
pkill -f "cursor agent"

# Wait 5 seconds, then resume
sleep 5
swamr continue --dir ./my-app --trust
```

**If swamr itself needs to be updated:**

```bash
cd ~/swamr
git pull
npm install
npm link  # re-link after update

# Re-init your project to get the latest agent rules
swamr init ./my-app
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `swamr: command not found` | Run `cd ~/swamr && npm link` again |
| `cursor agent login` fails | Open Cursor app → sign in → retry CLI login |
| Agents are writing but nothing's happening | Check `swamr/blockers/` — there may be a blocker waiting for your input |
| Build stopped mid-way | Run `swamr continue --dir ./my-app --trust` |
| Supabase connection error | Check `.env.local` has all 3 keys (URL, anon key, service role key) |
| `npm link` breaks after Node version change | `cd ~/swamr && npm link` with the new Node version active |
| Agent keeps failing the same task | Check `swamr/brain/03-build/issues/` for logged errors; edit the task in `swamr/tasks.json` to add more context, then `swamr continue` |
| Out of Cursor credits | Upgrade to Cursor Pro; or wait for the monthly reset |
| Google Maps key warning | Add `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY` or `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` to `.env.local` |
| `build.db: database is locked` (Xcode) | `pkill -f xcodebuild && rm -f path/to/build.db` then retry |

---

## Project Structure Reference

```
~/swamr/                    ← swamr CLI installation (not your project)
├── src/                    ← TypeScript source for the CLI
│   ├── cli.ts              ← Entry point and command parser
│   ├── init.ts             ← swamr init logic
│   ├── build.ts            ← swamr build / continue / adopt logic
│   └── brain.ts            ← Obsidian brain scaffolding
├── dist/                   ← Compiled CLI (built from src/)
├── rules/                  ← Base swamr agent rules
└── package.json

your-project/               ← Your actual project
├── .cursor/
│   └── rules/              ← 150+ agent .mdc files (installed by swamr init)
├── swamr/
│   ├── brain/              ← Obsidian vault (open this in Obsidian)
│   ├── plan.md             ← Human-readable project plan
│   ├── tasks.json          ← Machine-readable task list with dependencies
│   ├── state.json          ← Execution state (gitignored — used for resume)
│   ├── config.json         ← Agent limits and phase configuration
│   ├── blockers/           ← Files written when agents need human input
│   ├── evidence/           ← QA screenshots and logs (gitignored)
│   └── NEEDS-YOU.md        ← List of things waiting for your action
├── src/                    ← Your app source code
└── .env.local              ← Your secrets (gitignored — never commit this)
```

---

## Credits

- **Inspired by [Ruflo](https://github.com/hrishioa/ruflo)** — the autonomous Claude Code orchestrator that proved what agent swarms can do
- **Agent skills by [Agency Agents](https://github.com/msitarzewski/agency-agents)** by [@msitarzewski](https://github.com/msitarzewski) — the open-source roster of 150+ specialist AI agent definitions that power the swarm
- **Built for [Cursor](https://cursor.com)** — the AI-first code editor

---

## License

MIT — built by [Ved Thakar](https://github.com/Vedthakar)
