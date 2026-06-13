#!/usr/bin/env bash
#
# setup.sh — One-command setup for the Swamr agent swarm in any project.
#
# Usage:
#   cd /path/to/your/project
#   /path/to/swamr/setup.sh
#
# What it does:
#   1. Clones agency-agents repo (or updates if already present)
#   2. Converts all agents to Cursor .mdc rules
#   3. Installs the swarm orchestrator rules into .cursor/rules/
#   4. Creates project config files
#   5. Installs Playwright if needed for browser automation
#
set -euo pipefail

SWAMR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${1:-$(pwd)}"

# Colors
if [[ -t 1 ]]; then
  GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; CYAN=$'\033[0;36m'
  BOLD=$'\033[1m'; RESET=$'\033[0m'
else
  GREEN=''; YELLOW=''; CYAN=''; BOLD=''; RESET=''
fi

info()   { printf "${GREEN}[✓]${RESET} %s\n" "$*"; }
warn()   { printf "${YELLOW}[!]${RESET} %s\n" "$*"; }
header() { printf "\n${BOLD}${CYAN}%s${RESET}\n" "$*"; }

header "🐝 Swamr — Agent Swarm Setup"
echo "  Project: $PROJECT_DIR"
echo "  Swamr:   $SWAMR_DIR"
echo ""

# --- Step 1: Clone or update agency-agents ---
AGENCY_DIR="$SWAMR_DIR/.agency-agents"
if [[ -d "$AGENCY_DIR/.git" ]]; then
  header "Updating agency-agents..."
  git -C "$AGENCY_DIR" pull --ff-only 2>/dev/null || warn "Could not update, using existing"
  info "Agency agents up to date"
else
  header "Cloning agency-agents..."
  git clone --depth 1 https://github.com/msitarzewski/agency-agents.git "$AGENCY_DIR"
  info "Cloned agency-agents"
fi

# --- Step 2: Convert agents to Cursor format ---
header "Converting agents to Cursor rules..."
cd "$AGENCY_DIR"
bash scripts/convert.sh --tool cursor
cd "$PROJECT_DIR"
info "Converted all agents"

# --- Step 3: Install rules into project ---
header "Installing Cursor rules into project..."
mkdir -p "$PROJECT_DIR/.cursor/rules"

# Copy agency agent rules
if [[ -d "$AGENCY_DIR/integrations/cursor/rules" ]]; then
  cp "$AGENCY_DIR/integrations/cursor/rules/"*.mdc "$PROJECT_DIR/.cursor/rules/" 2>/dev/null || true
  AGENT_COUNT=$(ls "$AGENCY_DIR/integrations/cursor/rules/"*.mdc 2>/dev/null | wc -l | tr -d ' ')
  info "Installed $AGENT_COUNT agent skills"
fi

# Copy swamr orchestrator rules (these are the special sauce)
for rule_file in "$SWAMR_DIR/rules/"*.mdc; do
  [[ -f "$rule_file" ]] || continue
  cp "$rule_file" "$PROJECT_DIR/.cursor/rules/"
done
info "Installed swamr orchestrator rules"

# --- Step 4: Create project config ---
header "Setting up project config..."

# Create swamr config if it doesn't exist
if [[ ! -f "$PROJECT_DIR/.swamr/config.json" ]]; then
  mkdir -p "$PROJECT_DIR/.swamr"
  cat > "$PROJECT_DIR/.swamr/config.json" <<'JSON'
{
  "version": "1.0.0",
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
  ],
  "tracks": {
    "frontend": true,
    "backend": true,
    "infra": true,
    "testing": true,
    "docs": true
  }
}
JSON
  info "Created .swamr/config.json"
else
  info "Config already exists, skipping"
fi

# Create gitignore for swamr state
if [[ ! -f "$PROJECT_DIR/.swamr/.gitignore" ]]; then
  cat > "$PROJECT_DIR/.swamr/.gitignore" <<'GITIGNORE'
state.json
evidence/
scripts/
logs/
*.lock
GITIGNORE
  info "Created .swamr/.gitignore"
fi

# --- Step 5: Initialize Obsidian Brain ---
header "Setting up Obsidian brain vault..."
BRAIN_DIR="$PROJECT_DIR/.swamr/brain"
if [[ ! -d "$BRAIN_DIR" ]]; then
  mkdir -p "$BRAIN_DIR"/{00-project,01-planning,01-planning/decisions,02-foundation,03-build,03-build/task-outputs,03-build/issues,04-testing,05-hardening,06-launch,templates}

  # Vault index
  cat > "$BRAIN_DIR/index.md" <<'MD'
# Swamr Brain

> The second brain for your agent swarm. Agents read from and write to this vault so no context is ever lost across phases or sessions.

## Quick Links
- [[00-project/overview|Project Overview]]
- [[00-project/tech-stack|Tech Stack]]
- [[00-project/architecture|Architecture]]
- [[01-planning/task-tree|Task Tree]]
- [[01-planning/requirements|Requirements]]
- [[03-build/phase-log|Build Log]]

## How This Works
1. The orchestrator initializes this vault when a build starts
2. Every agent reads relevant notes before starting a task
3. Every agent writes a task output note when done
4. Phase summaries capture carry-forward context
5. You can browse this vault in Obsidian to watch progress in real-time

## Status
- **Phase**: Not started
- **Tasks**: 0/0
- **Last Updated**: —
MD

  # Project overview placeholder
  cat > "$BRAIN_DIR/00-project/overview.md" <<'MD'
# Project Overview

> This file is populated by the orchestrator when a build begins.

## Name
[TBD]

## Description
[TBD]

## Goals
- [TBD]

## Constraints
- [TBD]
MD

  # Tech stack placeholder
  cat > "$BRAIN_DIR/00-project/tech-stack.md" <<'MD'
# Tech Stack

> Populated by the orchestrator during planning.

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Frontend | TBD | — |
| Backend | TBD | — |
| Database | TBD | — |
| Auth | TBD | — |
| Hosting | TBD | — |
MD

  # Architecture placeholder
  cat > "$BRAIN_DIR/00-project/architecture.md" <<'MD'
# Architecture

> Populated by the orchestrator during planning. Updated as decisions are made.

## System Overview
[TBD]

## Data Flow
[TBD]

## Key Decisions
[See [[01-planning/decisions/]] for Architecture Decision Records]
MD

  # Glossary
  cat > "$BRAIN_DIR/00-project/glossary.md" <<'MD'
# Glossary

> Domain terms and definitions. Agents add to this as they encounter new terms.

| Term | Definition |
|------|-----------|
| — | — |
MD

  # Task tree placeholder
  cat > "$BRAIN_DIR/01-planning/task-tree.md" <<'MD'
# Task Tree

> Generated by @swamr-planner. Master list of all tasks with dependencies.

## Phase 1: Foundation
[TBD]

## Phase 2: Build
[TBD]

## Phase 3: Testing
[TBD]

## Phase 4: Hardening
[TBD]

## Phase 5: Launch
[TBD]
MD

  # Requirements placeholder
  cat > "$BRAIN_DIR/01-planning/requirements.md" <<'MD'
# Requirements

> Detailed requirements breakdown. Populated during planning.

## Functional Requirements
- [TBD]

## Non-Functional Requirements
- [TBD]

## Out of Scope
- [TBD]
MD

  # Risk register
  cat > "$BRAIN_DIR/01-planning/risk-register.md" <<'MD'
# Risk Register

| Risk | Impact | Likelihood | Mitigation |
|------|--------|-----------|-----------|
| — | — | — | — |
MD

  # Build phase log
  cat > "$BRAIN_DIR/03-build/phase-log.md" <<'MD'
# Build Phase Log

> Running log of build progress. Updated by the orchestrator after each task.

## Timeline
| Date | Task | Agent | Status | Notes |
|------|------|-------|--------|-------|
| — | — | — | — | — |
MD

  # Templates
  cat > "$BRAIN_DIR/templates/task-output.md" <<'MD'
---
task_id: [ID]
agent: [agent-slug]
phase: [phase number]
status: completed
date: [ISO date]
files_changed: []
---

# Task: [Description]

## What Was Built
[1-3 sentence summary]

## Key Decisions
- [Decision]: [Why]

## Dependencies Created
- [What depends on this and why]

## Context for Next Agent
[What the next agent working in this area needs to know]

## Files Reference
| File | Purpose |
|------|---------|
| `path/to/file` | [what it does] |

## Open Questions
- [Anything unresolved]
MD

  cat > "$BRAIN_DIR/templates/decision-record.md" <<'MD'
---
id: ADR-[NNN]
title: [Decision Title]
status: accepted
date: [ISO date]
agent: [agent-slug]
---

# ADR-[NNN]: [Decision Title]

## Context
[What prompted this decision]

## Decision
[What we decided]

## Rationale
[Why we chose this over alternatives]

## Alternatives Considered
1. [Alternative 1] — rejected because [reason]
2. [Alternative 2] — rejected because [reason]

## Consequences
- [Positive consequence]
- [Trade-off or negative consequence]
MD

  cat > "$BRAIN_DIR/templates/phase-summary.md" <<'MD'
---
phase: [number]
name: [phase name]
completed: [ISO date]
tasks_completed: [count]
tasks_failed: [count]
---

# Phase [N] Summary: [Name]

## What Was Accomplished
[Summary]

## Architecture State
[Current state of the codebase]

## Carry-Forward Context
[Critical info the next phase needs — this prevents context loss]

## Known Issues
- [Issue 1]

## Metrics
- Tasks completed: X/Y
- QA pass rate: Z%
MD

  # Obsidian config for the vault
  mkdir -p "$BRAIN_DIR/.obsidian"
  cat > "$BRAIN_DIR/.obsidian/app.json" <<'JSON'
{
  "showLineNumber": true,
  "strictLineBreaks": false,
  "readableLineLength": true
}
JSON

  info "Created Obsidian brain vault at .swamr/brain/"
else
  info "Obsidian brain already exists, skipping"
fi

# --- Step 6: Install Playwright if needed ---
header "Checking browser automation..."
if command -v npx &>/dev/null; then
  if ! npx playwright --version &>/dev/null 2>&1; then
    warn "Playwright not installed. Install with: npx playwright install"
    echo "  (Needed for browser automation — Supabase setup, visual testing, etc.)"
  else
    info "Playwright available"
  fi
else
  warn "npx not found — install Node.js for browser automation support"
fi

# --- Done ---
echo ""
header "✅ Swamr is ready!"
echo ""
echo "  To start building, open this project in Cursor and type:"
echo ""
echo "    ${BOLD}@swamr-orchestrator Build me [describe your app]${RESET}"
echo ""
echo "  Or for more control:"
echo ""
echo "    ${BOLD}@swamr-orchestrator Plan a [type] app with [features]${RESET}"
echo "    ${BOLD}@swamr-planner Show me the task breakdown${RESET}"
echo "    ${BOLD}@swamr-orchestrator Execute the plan${RESET}"
echo ""
echo "  The agents will automatically:"
echo "    • Initialize an Obsidian vault as the project's second brain"
echo "    • Decompose your request into tasks"
echo "    • Select the right specialist agent for each task"
echo "    • Work in phases so context is never lost"
echo "    • Run dev↔QA loops until each task passes"
echo "    • Handle browser setup (Supabase, etc.) via Playwright"
echo "    • Produce a production-ready, tested codebase"
echo ""
echo "  ${BOLD}Open .swamr/brain/ as an Obsidian vault to watch progress live!${RESET}"
echo ""
