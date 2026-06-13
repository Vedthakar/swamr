# Swamr

**An agent swarm for Cursor that builds entire projects autonomously.**

Drop Swamr into any project, tell it what to build, and watch 150+ specialist AI agents plan, code, test, and deploy — while an Obsidian vault tracks every decision so no context is ever lost.

> Inspired by [Ruflo](https://github.com/hrishioa/ruflo) (autonomous Claude Code orchestrator). Agent skills powered by [Agency Agents](https://github.com/msitarzewski/agency-agents) by [@msitarzewski](https://github.com/msitarzewski).

---

## What It Does

You type one sentence in Cursor. Swamr does the rest:

```
@swamr-orchestrator Build me a SaaS dashboard with user auth, 
team management, billing via Stripe, and a REST API backed by Supabase.
```

The orchestrator:
1. Creates an Obsidian vault (`.swamr/brain/`) as the project's second brain
2. Generates a full project plan with 30-50 tasks
3. Selects the right specialist agent for each task (frontend, backend, security, legal, testing...)
4. Executes in strict phases — foundation, build, test, harden, launch
5. Runs QA validation after every single task
6. Retries failures up to 3x with specific feedback
7. Writes every decision, output, and issue to the Obsidian brain
8. Delivers a production-ready, tested codebase

No context is lost between phases because every agent reads from and writes to the shared brain.

---

## Prerequisites

| Tool | Required? | Install |
|------|-----------|---------|
| **Cursor** | Yes | [cursor.com](https://cursor.com) (Pro recommended for unlimited usage) |
| **Obsidian** | Highly recommended | [obsidian.md](https://obsidian.md) (free) |
| **Node.js 18+** | Yes | [nodejs.org](https://nodejs.org) |
| **Git** | Yes | Comes with most OS installs |
| **Playwright** | Optional | `npx playwright install` (for browser automation) |

---

## Setup

### 1. Clone Swamr

```bash
git clone https://github.com/vedthakar/swamr.git ~/swamr
```

### 2. Initialize in Your Project

```bash
# New project
cd ~/my-new-app
~/swamr/init-project.sh .

# Or create a new directory
~/swamr/init-project.sh ~/my-new-app
```

This does everything:
- Clones 150+ agent skills from [agency-agents](https://github.com/msitarzewski/agency-agents)
- Converts them to Cursor `.mdc` rule files
- Installs the orchestrator, planner, QA loop, and brain system
- Creates the Obsidian vault structure
- Sets up git and gitignore

### 3. Open in Cursor + Obsidian

```bash
# Open the project in Cursor
cursor ~/my-new-app

# Open the brain vault in Obsidian
# File → Open Vault → ~/my-new-app/.swamr/brain/
```

### 4. Build Something

In Cursor's chat:

```
@swamr-orchestrator Build me a project management tool with kanban boards, 
team collaboration, real-time updates, and Supabase backend.
```

Watch the Obsidian vault fill up with architecture decisions, task outputs, and progress notes as the agents work.

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
   Review `.swamr/plan.md`, make changes, then:
   ```
   @swamr-orchestrator Execute the plan
   ```

3. **Define your phases clearly** — The agents work best when they know the full scope upfront. A vague "build me something cool" produces worse results than "Build a Next.js app with these 5 pages, this database schema, and this auth flow."

4. **Watch the Obsidian vault** — Open `.swamr/brain/` in Obsidian to see decisions being made in real-time. If you see the agents going in the wrong direction, you can intervene early.

5. **Let phases complete** — The system works in strict phases (foundation → build → test → harden → launch). Each phase summary carries context forward. Don't skip phases.

---

## Architecture

```
You (describe what to build)
  │
  ▼
@swamr-orchestrator
  │
  ├── Initializes Obsidian brain (.swamr/brain/)
  │
  ├── @swamr-planner (decomposes into phased tasks)
  │
  ├── @swamr-skill-selector (picks agent per task)
  │
  ├── FOR EACH phase:
  │   ├── FOR EACH task in phase:
  │   │   ├── Agent reads context from brain
  │   │   ├── @[specialist-agent] builds it
  │   │   ├── Agent writes output to brain
  │   │   ├── @swamr-qa-loop validates it
  │   │   └── Retry or advance
  │   └── Write phase summary to brain
  │
  ├── @swamr-browser-agent (Supabase setup, OAuth, etc.)
  │
  └── @swamr-state-manager (tracks progress in .swamr/state.json)
```

### The Obsidian Brain

The brain is what makes Swamr different from just using Cursor normally. It's a structured Obsidian vault that agents use as shared memory:

```
.swamr/brain/
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

### Build a full project from scratch
```
@swamr-orchestrator Build me a habit tracking app with streaks, 
social accountability, push notifications, and a React Native mobile client.
```

### Plan first, review, then execute
```
@swamr-planner Plan an e-commerce platform with product catalog, 
cart, checkout, Stripe payments, and admin dashboard.

# Review .swamr/plan.md and .swamr/brain/01-planning/task-tree.md
# Make any changes you want, then:

@swamr-orchestrator Execute the plan
```

### Resume after closing Cursor
```
@swamr-orchestrator Resume the build
```
The orchestrator reads `.swamr/state.json` and the latest brain notes to pick up exactly where it left off.

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

Edit `.swamr/config.json` to customize behavior:

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
git pull                              # Update Swamr itself
./setup.sh ~/path/to/your/project     # Re-install with latest agents
```

The agency-agents repo is re-pulled automatically during setup.

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

Swamr doesn't run a separate orchestration server or Python process. It works entirely through Cursor's native rule system (`.mdc` files):

1. **`.cursor/rules/swamr-orchestrator.mdc`** — When you `@mention` this in chat, Cursor loads the orchestrator persona which knows how to plan, dispatch, and track
2. **`.cursor/rules/<agent>.mdc`** — 150+ agent personas the orchestrator dispatches to via `@mentions`
3. **`.swamr/brain/`** — Obsidian vault on disk that agents read/write for context persistence
4. **`.swamr/state.json`** — JSON file tracking task progress for resume capability

No external dependencies. No API keys. No running processes. Just Cursor + files.

---

## Credits

- **Inspired by [Ruflo](https://github.com/hrishioa/ruflo)** — the autonomous orchestrator for Claude Code that showed what's possible with agent swarms
- **Agent skills by [Agency Agents](https://github.com/msitarzewski/agency-agents)** by [@msitarzewski](https://github.com/msitarzewski) — the incredible open-source roster of 150+ specialist AI agent definitions
- **Built for [Cursor](https://cursor.com)** — the AI-first code editor

---

## License

MIT
