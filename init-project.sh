#!/usr/bin/env bash
#
# init-project.sh — Initialize Swamr in an existing or new project directory.
#
# Usage:
#   /path/to/swamr/init-project.sh [project-dir]
#
# If project-dir doesn't exist, creates it.
# If no argument, uses current directory.
#
set -euo pipefail

SWAMR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${1:-$(pwd)}"

# Colors
if [[ -t 1 ]]; then
  GREEN=$'\033[0;32m'; CYAN=$'\033[0;36m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
else
  GREEN=''; CYAN=''; BOLD=''; RESET=''
fi

info()   { printf "${GREEN}[✓]${RESET} %s\n" "$*"; }
header() { printf "\n${BOLD}${CYAN}%s${RESET}\n" "$*"; }

# Create project dir if needed
if [[ ! -d "$PROJECT_DIR" ]]; then
  mkdir -p "$PROJECT_DIR"
  info "Created $PROJECT_DIR"
fi

cd "$PROJECT_DIR"
PROJECT_DIR="$(pwd)"

header "🐝 Initializing Swamr in $PROJECT_DIR"

# Run the full setup
bash "$SWAMR_DIR/setup.sh" "$PROJECT_DIR"

# Initialize git if not already
if [[ ! -d "$PROJECT_DIR/.git" ]]; then
  git init "$PROJECT_DIR" >/dev/null 2>&1
  info "Initialized git repository"
fi

# Create .gitignore entries for swamr
if [[ -f "$PROJECT_DIR/.gitignore" ]]; then
  if ! grep -q '.swamr/state' "$PROJECT_DIR/.gitignore" 2>/dev/null; then
    cat >> "$PROJECT_DIR/.gitignore" <<'EOF'

# Swamr agent state (ephemeral)
.swamr/state.json
.swamr/evidence/
.swamr/scripts/
.swamr/logs/

# Obsidian internals (vault content IS tracked)
.swamr/brain/.obsidian/workspace.json
.swamr/brain/.obsidian/workspace-mobile.json
EOF
    info "Updated .gitignore"
  fi
else
  cat > "$PROJECT_DIR/.gitignore" <<'EOF'
node_modules/
.env
.env.local
.env.*.local

# Swamr agent state (ephemeral)
.swamr/state.json
.swamr/evidence/
.swamr/scripts/
.swamr/logs/

# Obsidian internals (vault content IS tracked)
.swamr/brain/.obsidian/workspace.json
.swamr/brain/.obsidian/workspace-mobile.json
EOF
  info "Created .gitignore"
fi

echo ""
header "✅ Ready!"
echo ""
echo "  1. Open this folder in Cursor"
echo "  2. Open .swamr/brain/ as an Obsidian vault"
echo "  3. Type: @swamr-orchestrator Build me [your app]"
echo ""
