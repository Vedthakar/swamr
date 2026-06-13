# Swamr

**An agent swarm for Cursor that builds entire projects autonomously.**

Drop Swamr into any project, tell it what to build, and watch 150+ specialist AI agents plan, code, test, and deploy — while an Obsidian vault tracks every decision so no context is ever lost.

> Inspired by [Ruflo](https://github.com/hrishioa/ruflo) (autonomous Claude Code orchestrator). Agent skills powered by [Agency Agents](https://github.com/msitarzewski/agency-agents) by [@msitarzewski](https://github.com/msitarzewski).

---

## What It Does

### Two ways to build:

**Option A: CLI Multi-Agent Mode (recommended)** — spawns real parallel agents via `cursor agent`:

```bash
swamr init ./my-app
swamr build --dir ./my-app "A SaaS dashboard with auth, billing, and team management"
```

This spawns **actual separate Cursor agent processes** running in parallel — one per task. A planning agent decomposes your request into 25-40 tasks, then worker agents execute them simultaneously across foundation, build, test, harden, and launch phases.

**Option B: Single-Agent Mode** — use `@swamr-orchestrator` in Cursor's chat:

```
@swamr-orchestrator Build me a SaaS dashboard with user auth, 
team management, billing via Stripe, and a REST API backed by Supabase.
```

This runs in one Cursor chat window. Simpler but sequential — one agent does everything by switching personas.

### What happens either way:

1. Creates an Obsidian vault (`swamr/brain/`) as the project's second brain
2. Generates a full project plan with 25-40 tasks
3. Selects the right specialist agent for each task (frontend, backend, security, legal, testing...)
4. Executes in strict phases — foundation, build, test, harden, launch
5. Retries failures up to 3x with specific feedback
6. Writes every decision, output, and issue to the Obsidian brain
7. Delivers a production-ready, tested codebase

No context is lost between phases because every agent reads from and writes to the shared brain.

---

## Prerequisites

| Tool | Required? | Install |
|------|-----------|---------|
| **Cursor** | Yes | [cursor.com](https://cursor.com) (Pro recommended for unlimited usage) |
| **Cursor CLI** | For multi-agent mode | Included with Cursor. Run `cursor agent login` to authenticate. |
| **Obsidian** | Highly recommended | [obsidian.md](https://obsidian.md) (free) |
| **Node.js 18+** | Yes | [nodejs.org](https://nodejs.org) |
| **Git** | Yes | Comes with most OS installs |
| **Playwright** | Optional | `npx playwright install` (for browser automation) |

---

## Setup

### 1. Install Swamr

```bash
git clone https://github.com/Vedthakar/swamr.git ~/swamr
cd ~/swamr
npm install
npm link
```

Verify it works:

```bash
swamr --help
```

You should see the Swamr help menu with `init` and `build` commands.

> **Note:** `npm link` wires the `swamr` command into whichever Node.js version is currently active in your shell. If you switch Node versions with nvm, run `npm link` again from `~/swamr`.

### 2. Initialize in Your Project

```bash
# Create a new project and initialize Swamr in it
swamr init ./my-new-app

# Or initialize in an existing project directory
cd ./my-existing-app
swamr init
```

This does everything automatically:
- Clones 150+ agent skills from [agency-agents](https://github.com/msitarzewski/agency-agents)
- Converts them to Cursor `.mdc` rule files
- Installs the orchestrator, planner, QA loop, and brain system
- Creates the Obsidian vault structure with templates
- Sets up git and gitignore

### 3. Open the Brain in Obsidian (optional but recommended)

```bash
# In Obsidian: File → Open Vault → select ~/my-new-app/swamr/brain/
```

Watch the vault fill up with architecture decisions, task outputs, and progress notes as agents work.

### 4. Build Something

You have two options:

#### Option A: CLI Multi-Agent Mode (recommended for big projects)

This spawns **real parallel agent processes** — multiple agents working simultaneously.

```bash
# Authenticate cursor CLI first (one-time setup)
cursor agent login

# Build your project
swamr build --dir ./my-new-app "A project management tool with kanban boards and real-time updates"
```

You can also plan first and review before executing:

```bash
swamr build --dir ./my-new-app --plan-only "Your app description"
# Review swamr/plan.md and swamr/tasks.json, then:
swamr build --dir ./my-new-app --resume
```

#### Option B: Single-Agent Mode (simpler, runs inside Cursor chat)

1. Open the project in Cursor: `cursor ~/my-new-app`
2. In the chat panel, click the mode dropdown and select **Agent** (not Chat, not Plan Mode)
3. Type your prompt:

```
@swamr-orchestrator Build me a project management tool with kanban boards, 
team collaboration, real-time updates, and Supabase backend.
```

> **Important:** Single-agent mode only works in **Agent mode** (the `∞ Agent` option in Cursor's chat dropdown). Regular Chat mode just writes text — it can't read files or run commands. Plan Mode pauses for approval before every action, which slows the swarm to a crawl.

---

## How to Get the Best Results

> **Plan your architecture first.** The single biggest thing you can do for build quality is to think through what you want before the agents start coding.

### Recommended Workflow

1. **Think through your app** — What are the core features? What's the data model? What does the user flow look like?

2. **Plan first, build second** — Use the planner to generate a task tree, review it, and adjust before execution:
   ```
   @swamr-planner Plan a recipe sharing app with social features, 
   meal planning, and grocery list generation.
   ```
   Review `swamr/plan.md`, make changes, then:
   ```
   @swamr-orchestrator Execute the plan
   ```

3. **Define your phases clearly** — The agents work best when they know the full scope upfront. A vague "build me something cool" produces worse results than "Build a Next.js app with these 5 pages, this database schema, and this auth flow."

4. **Watch the Obsidian vault** — Open `swamr/brain/` in Obsidian to see decisions being made in real-time. If you see the agents going in the wrong direction, you can intervene early.

5. **Let phases complete** — The system works in strict phases (foundation → build → test → harden → launch). Each phase summary carries context forward. Don't skip phases.

---

## Architecture

### CLI Multi-Agent Mode (`swamr build`)

```
swamr build "description"
  │
  ├── PLANNER (1 cursor agent, smart model)
  │   ├── Reads .cursor/rules/ to understand available agents
  │   ├── Writes plan.md + tasks.json (25-40 tasks)
  │   └── Writes architecture to swamr/brain/
  │
  ├── FOUNDATION PHASE (2-4 cursor agents in parallel)
  │   ├── Agent 1: scaffold project
  │   ├── Agent 2: database schema
  │   ├── Agent 3: auth system
  │   └── Agent 4: design system
  │
  ├── BUILD PHASE (up to 8 cursor agents in parallel)
  │   ├── Agent: @frontend-developer → dashboard page
  │   ├── Agent: @frontend-developer → settings page
  │   ├── Agent: @backend-architect → API routes
  │   ├── Agent: @frontend-developer → user profile
  │   └── ... (tasks dispatched as dependencies resolve)
  │
  ├── TESTING PHASE (3-5 cursor agents in parallel)
  │   ├── Agent: @evidence-collector → unit tests
  │   ├── Agent: @api-tester → API tests
  │   └── Agent: @testing-reality-checker → E2E tests
  │
  ├── HARDENING PHASE (4 cursor agents in parallel)
  │   ├── Agent: @security-architect → security audit
  │   ├── Agent: @performance-benchmarker → perf audit
  │   ├── Agent: @accessibility-auditor → a11y audit
  │   └── Agent: @legal-compliance-checker → compliance
  │
  └── LAUNCH PHASE (2-3 cursor agents)
      ├── Agent: @engineering-technical-writer → docs
      ├── Agent: @devops-automator → deploy
      └── Agent: @testing-reality-checker → final validation
```

Each box is a **real separate `cursor agent` process** running in its own context. They share the codebase via the filesystem and the Obsidian brain vault.

### Single-Agent Mode (`@swamr-orchestrator` in Cursor chat)

```
@swamr-orchestrator
  │
  ├── Initializes Obsidian brain (swamr/brain/)
  ├── @swamr-planner (decomposes into phased tasks)
  ├── @swamr-skill-selector (picks agent per task)
  ├── FOR EACH phase → FOR EACH task:
  │   ├── @[specialist-agent] builds it
  │   ├── @swamr-qa-loop validates it
  │   └── Retry or advance
  └── @swamr-state-manager (tracks progress)
```

### The Obsidian Brain

The brain is what makes Swamr different from just using Cursor normally. It's a structured Obsidian vault that agents use as shared memory:

```
swamr/brain/
├── 00-project/          # What we're building and why
│   ├── overview.md
│   ├── tech-stack.md
│   ├── architecture.md
│   └── glossary.md
├── 01-planning/         # How we're building it
│   ├── requirements.md
│   ├── task-tree.md
│   ├── risk-register.md
│   └── decisions/       # Architecture Decision Records
├── 02-foundation/       # Foundation phase outputs
├── 03-build/            # Build phase
│   ├── phase-log.md     # Running timeline
│   ├── task-outputs/    # One note per completed task
│   └── issues/          # Bugs and problems found
├── 04-testing/          # Test plans and results
├── 05-hardening/        # Security, perf, a11y, legal
├── 06-launch/           # Deploy runbooks and handoff
└── templates/           # Note templates agents use
```

**Every agent reads before working and writes after completing.** Phase summaries carry context forward so the 50th task has the same understanding as the 1st.

### Available Agents (150+)

Swamr installs the full [Agency Agents](https://github.com/msitarzewski/agency-agents) roster:

| Category | Examples | Count |
|----------|---------|-------|
| **Engineering** | frontend-developer, backend-architect, devops-automator, ai-engineer, database-optimizer | ~30 |
| **Testing & QA** | evidence-collector, reality-checker, api-tester, performance-benchmarker, accessibility-auditor | ~8 |
| **Security** | security-architect, appsec-engineer, compliance-auditor, penetration-tester | ~10 |
| **Design** | ui-designer, ux-architect, brand-guardian, ux-researcher | ~9 |
| **Product & PM** | project-manager-senior, sprint-prioritizer, workflow-architect | ~8 |
| **Marketing** | growth-hacker, seo-specialist, content-creator, social-media-strategist | ~15 |
| **Finance & Legal** | financial-analyst, legal-compliance-checker, bookkeeper-controller | ~5 |
| **Support & Ops** | analytics-reporter, infrastructure-maintainer, technical-writer | ~6 |
| **Specialized** | prompt-engineer, data-privacy-officer, grant-writer, and many more | ~50+ |

The orchestrator automatically selects the right agent for each task based on the task description and tech stack.

---

## Usage Patterns

### CLI Multi-Agent: Build a full project
```bash
swamr build --dir ./my-app "A habit tracking app with streaks, social accountability, and push notifications"
```

### CLI Multi-Agent: Plan only, review, then execute
```bash
# Generate the plan without executing
swamr build --dir ./my-app --plan-only "An e-commerce platform with product catalog, cart, and Stripe payments"

# Review swamr/plan.md and swamr/tasks.json, make changes, then:
swamr build --dir ./my-app --resume
```

### CLI Multi-Agent: Resume after interruption
```bash
swamr build --dir ./my-app --resume
```

### Single-Agent: Build in Cursor chat
```
@swamr-orchestrator Build me a habit tracking app with streaks, 
social accountability, push notifications, and a React Native mobile client.
```

### Single-Agent: Plan first, review, then execute
```
@swamr-planner Plan an e-commerce platform with product catalog, 
cart, checkout, Stripe payments, and admin dashboard.

# Review swamr/plan.md and swamr/brain/01-planning/task-tree.md
# Make any changes you want, then:

@swamr-orchestrator Execute the plan
```

### Resume in Cursor chat
```
@swamr-orchestrator Resume the build
```
The orchestrator reads `swamr/state.json` and the latest brain notes to pick up exactly where it left off.

### Check progress
```
@swamr-state-manager Show progress report
```

### Use a specific agent directly
```
@frontend-developer Build a responsive data table with sorting, filtering, and pagination
@security-architect Audit the authentication implementation for vulnerabilities
@backend-architect Design the API for real-time collaborative editing
```

---

## Configuration

Edit `swamr/config.json` to customize behavior:

```json
{
  "max_parallel_agents": 8,
  "max_retries_per_task": 3,
  "quality_gates": true,
  "browser_automation": true,
  "phases": [
    "discovery",
    "planning",
    "architecture",
    "scaffold",
    "build",
    "test",
    "security",
    "legal",
    "deploy"
  ]
}
```

---

## MCP Integration

If you have MCP servers configured in Cursor, the agents use them automatically:

| MCP Server | Used For |
|-----------|---------|
| Supabase | Database operations, migrations, edge functions |
| Vercel | Deployments |
| GitHub | Repo operations, PR management |
| Slack | Build notifications |
| Any other | Detected and used when relevant |

---

## Updating

```bash
cd ~/swamr
git pull
npm install

# Then re-init any project to get the latest agents and rules
swamr init ~/path/to/your/project
```

The agency-agents repo is re-pulled automatically during init.

---

## Adding Custom Agents

Create a `.cursor/rules/my-agent.mdc` in your project:

```yaml
---
description: "My custom agent — describe what it specializes in"
globs: ""
alwaysApply: false
---

# My Agent

You are **My Agent**, a specialist in [domain].

## Your Mission
[What this agent does]

## Rules
[How it should behave]
```

Reference it in prompts: `@my-agent Do the thing`

---

## How It Works Under the Hood

### `swamr init` (setup)

TypeScript CLI that clones agency-agents, converts 232 agent definitions to Cursor `.mdc` rules, scaffolds the Obsidian vault, and configures the project. Run once per project.

### `swamr build` (multi-agent execution)

TypeScript CLI that uses `cursor agent` to spawn **real parallel agent processes**:

1. **Planning phase** — Spawns a single planning agent (smarter model) that reads the `.cursor/rules/` directory, decomposes the project into 25-40 tasks with dependencies, and writes `swamr/tasks.json` + `swamr/plan.md`
2. **Execution phases** — For each phase (foundation → build → testing → hardening → launch), spawns up to `max_parallel_agents` (default: 8) `cursor agent` processes in parallel, each with its own task, role, and prompt
3. **Dependency resolution** — Tasks only start when all their `depends_on` tasks are completed. New batches are dispatched as dependencies resolve.
4. **Retry logic** — Failed tasks retry up to `max_retries_per_task` (default: 3) times with specific feedback about the failure
5. **Brain integration** — Each agent gets the Obsidian brain context injected into its prompt. Task outputs are written to `swamr/brain/03-build/task-outputs/`. Phase summaries are written at the end of each phase.
6. **Resume** — State is saved to `swamr/state.json` after every task. Use `swamr build --resume` to pick up where you left off.

### Single-agent mode (`@swamr-orchestrator`)

When you use Cursor's chat with `@swamr-orchestrator`, a single agent handles everything sequentially by switching between specialist personas via `@mentions`.

### Key files

| File | Purpose |
|------|---------|
| `swamr/tasks.json` | Machine-readable task list with dependencies |
| `swamr/state.json` | Execution state for resume capability |
| `swamr/plan.md` | Human-readable project plan |
| `swamr/brain/` | Obsidian vault — shared memory between agents |
| `swamr/config.json` | Agent limits, retry counts, phase config |
| `.cursor/rules/*.mdc` | 232 agent personas + orchestrator rules |

No external servers. No API keys. Just `cursor agent` CLI + files on disk.

---

## Credits

- **Inspired by [Ruflo](https://github.com/hrishioa/ruflo)** — the autonomous orchestrator for Claude Code that showed what's possible with agent swarms
- **Agent skills by [Agency Agents](https://github.com/msitarzewski/agency-agents)** by [@msitarzewski](https://github.com/msitarzewski) — the incredible open-source roster of 150+ specialist AI agent definitions
- **Built for [Cursor](https://cursor.com)** — the AI-first code editor

---

## License

MIT
