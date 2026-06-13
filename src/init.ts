import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  info,
  warn,
  header,
  bold,
  run,
  runSafe,
  writeFileDeep,
  copyDirRecursive,
  commandExists,
} from "./utils.js";
import { initBrain } from "./brain.js";

const AGENCY_REPO = "https://github.com/msitarzewski/agency-agents.git";

export function init(targetDir: string) {
  const projectDir = path.resolve(targetDir);
  const swamrPkgDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

  if (!fs.existsSync(projectDir)) {
    fs.mkdirSync(projectDir, { recursive: true });
    info(`Created ${projectDir}`);
  }

  header("🐝 Swamr — Agent Swarm Setup");
  console.log(`  Project: ${projectDir}`);
  console.log(`  Swamr:   ${swamrPkgDir}`);
  console.log();

  // --- Step 1: Clone or update agency-agents ---
  const agencyDir = path.join(swamrPkgDir, ".agency-agents");
  if (fs.existsSync(path.join(agencyDir, ".git"))) {
    header("Updating agency-agents...");
    const pulled = runSafe("git pull --ff-only", agencyDir);
    if (pulled === null) warn("Could not update, using existing");
    info("Agency agents up to date");
  } else {
    header("Cloning agency-agents...");
    run(`git clone --depth 1 ${AGENCY_REPO} ${agencyDir}`);
    info("Cloned agency-agents");
  }

  // --- Step 2: Convert agents to Cursor format ---
  header("Converting agents to Cursor rules...");
  run("bash scripts/convert.sh --tool cursor", agencyDir);
  info("Converted all agents");

  // --- Step 3: Install rules into project ---
  header("Installing Cursor rules into project...");
  const rulesDir = path.join(projectDir, ".cursor", "rules");
  fs.mkdirSync(rulesDir, { recursive: true });

  // Copy agency agent rules
  const agencyRulesDir = path.join(agencyDir, "integrations", "cursor", "rules");
  let agentCount = 0;
  if (fs.existsSync(agencyRulesDir)) {
    const mdcFiles = fs
      .readdirSync(agencyRulesDir)
      .filter((f) => f.endsWith(".mdc"));
    for (const f of mdcFiles) {
      fs.copyFileSync(path.join(agencyRulesDir, f), path.join(rulesDir, f));
    }
    agentCount = mdcFiles.length;
    info(`Installed ${agentCount} agent skills`);
  }

  // Copy swamr orchestrator rules
  const swamrRulesDir = path.join(swamrPkgDir, "rules");
  if (fs.existsSync(swamrRulesDir)) {
    const ruleFiles = fs
      .readdirSync(swamrRulesDir)
      .filter((f) => f.endsWith(".mdc"));
    for (const f of ruleFiles) {
      fs.copyFileSync(path.join(swamrRulesDir, f), path.join(rulesDir, f));
    }
    info(`Installed ${ruleFiles.length} swamr orchestrator rules`);
  }

  // --- Step 4: Create project config ---
  header("Setting up project config...");
  const configPath = path.join(projectDir, "swamr", "config.json");
  if (!fs.existsSync(configPath)) {
    writeFileDeep(
      configPath,
      JSON.stringify(
        {
          version: "1.0.0",
          max_parallel_agents: 8,
          max_retries_per_task: 3,
          quality_gates: true,
          browser_automation: true,
          phases: [
            "discovery",
            "planning",
            "architecture",
            "scaffold",
            "build",
            "test",
            "security",
            "legal",
            "deploy",
          ],
          tracks: {
            frontend: true,
            backend: true,
            infra: true,
            testing: true,
            docs: true,
          },
        },
        null,
        2
      )
    );
    info("Created swamr/config.json");
  } else {
    info("Config already exists, skipping");
  }

  // Gitignore for swamr state
  const swamrGitignore = path.join(projectDir, "swamr", ".gitignore");
  if (!fs.existsSync(swamrGitignore)) {
    writeFileDeep(
      swamrGitignore,
      `state.json
evidence/
scripts/
logs/
*.lock
`
    );
    info("Created swamr/.gitignore");
  }

  // --- Step 5: Initialize Obsidian Brain ---
  header("Setting up Obsidian brain vault...");
  initBrain(projectDir);

  // --- Step 6: Check Playwright ---
  header("Checking browser automation...");
  if (commandExists("npx")) {
    const pwVersion = runSafe("npx playwright --version");
    if (pwVersion) {
      info("Playwright available");
    } else {
      warn("Playwright not installed. Install with: npx playwright install");
      console.log(
        "  (Needed for browser automation — Supabase setup, visual testing, etc.)"
      );
    }
  } else {
    warn("npx not found — install Node.js for browser automation support");
  }

  // --- Step 7: Init git if needed ---
  if (!fs.existsSync(path.join(projectDir, ".git"))) {
    run("git init", projectDir);
    info("Initialized git repository");
  }

  // --- Step 8: Update .gitignore ---
  const projectGitignore = path.join(projectDir, ".gitignore");
  const swamrIgnoreBlock = `
# Swamr agent state (ephemeral)
swamr/state.json
swamr/evidence/
swamr/scripts/
swamr/logs/

# Obsidian internals (vault content IS tracked)
swamr/brain/.obsidian/workspace.json
swamr/brain/.obsidian/workspace-mobile.json
`;

  if (fs.existsSync(projectGitignore)) {
    const existing = fs.readFileSync(projectGitignore, "utf-8");
    if (!existing.includes("swamr/state")) {
      fs.appendFileSync(projectGitignore, swamrIgnoreBlock);
      info("Updated .gitignore");
    }
  } else {
    writeFileDeep(
      projectGitignore,
      `node_modules/
.env
.env.local
.env.*.local
${swamrIgnoreBlock}`
    );
    info("Created .gitignore");
  }

  // --- Done ---
  console.log();
  header("✅ Swamr is ready!");
  console.log();
  console.log(`  To start building, open this project in Cursor and type:`);
  console.log();
  console.log(
    `    ${bold("@swamr-orchestrator Build me [describe your app]")}`
  );
  console.log();
  console.log(`  Or for more control:`);
  console.log();
  console.log(
    `    ${bold("@swamr-orchestrator Plan a [type] app with [features]")}`
  );
  console.log(`    ${bold("@swamr-planner Show me the task breakdown")}`);
  console.log(`    ${bold("@swamr-orchestrator Execute the plan")}`);
  console.log();
  console.log(`  The agents will automatically:`);
  console.log(
    `    • Initialize an Obsidian vault as the project's second brain`
  );
  console.log(`    • Decompose your request into tasks`);
  console.log(`    • Select the right specialist agent for each task`);
  console.log(`    • Work in phases so context is never lost`);
  console.log(`    • Run dev↔QA loops until each task passes`);
  console.log(`    • Handle browser setup (Supabase, etc.) via Playwright`);
  console.log(`    • Produce a production-ready, tested codebase`);
  console.log();
  console.log(
    `  ${bold("IMPORTANT: Use ∞ Agent mode in Cursor (not Chat mode)")}`
  );
  console.log(
    `  ${bold("Open swamr/brain/ as an Obsidian vault to watch progress live!")}`
  );
  console.log();
}
