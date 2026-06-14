#!/usr/bin/env node
import { init } from "./init.js";
import { build, continueBuild } from "./build.js";
const VERSION = "1.2.0";
function printUsage() {
    console.log(`
swamr v${VERSION} — Agent swarm for Cursor

Usage:
  swamr init [project-dir]              Set up Swamr in a project
  swamr build [options] "description"   Build a project with the agent swarm
  swamr continue [options]              Continue a previous Swamr build
  swamr --version                       Show version
  swamr --help                          Show this help

Commands:
  init [dir]        Initialize Swamr rules + Obsidian brain in a project
                    (default: current directory)

  build [options] "description"
                    Spawn multiple Cursor agents to build a project.
                    Uses cursor agent CLI to run agents in parallel.

    Options:
      --dir <path>       Project directory (default: current dir)
      --model <model>    Model for planning/worker agents (default: auto)
      --plan-only        Generate the plan but don't execute
      --resume           Resume from existing swamr/state.json
      --trust            Auto-approve all agent commands (skip approval prompts)
                         Without this flag, agents will ask before running commands.

  continue [options]
                    Resume from swamr/state.json without re-planning.
                    Requeues failed/skipped tasks and continues from saved state.

    Options:
      --dir <path>       Project directory (default: current dir)
      --model <model>    Model for worker agents (default: auto)
      --trust            Auto-approve all agent commands (skip approval prompts)

Examples:
  swamr init ./my-app
  swamr build "A SaaS dashboard with auth, billing, and team management"
  swamr build --trust "A SaaS dashboard with auth, billing, and team management"
  swamr build --dir ./my-app --plan-only "Recipe sharing app with social features"
  swamr continue --dir ./my-app
`);
}
async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
        printUsage();
        process.exit(0);
    }
    if (args.includes("--version") || args.includes("-v")) {
        console.log(VERSION);
        process.exit(0);
    }
    const command = args[0];
    switch (command) {
        case "init": {
            const targetDir = args[1] || ".";
            init(targetDir);
            break;
        }
        case "build": {
            const buildArgs = args.slice(1);
            let dir = ".";
            let model;
            let planOnly = false;
            let resume = false;
            let trust = false;
            let description = "";
            for (let i = 0; i < buildArgs.length; i++) {
                switch (buildArgs[i]) {
                    case "--dir":
                        dir = buildArgs[++i];
                        break;
                    case "--model":
                        model = buildArgs[++i];
                        break;
                    case "--plan-only":
                        planOnly = true;
                        break;
                    case "--resume":
                        resume = true;
                        break;
                    case "--trust":
                        trust = true;
                        break;
                    default:
                        if (!buildArgs[i].startsWith("--")) {
                            description = buildArgs[i];
                        }
                }
            }
            if (!description && !resume) {
                console.error('❌ Please provide a project description: swamr build "Your app description"');
                process.exit(1);
            }
            await build(dir, description || "Resume previous build", {
                model,
                plan_only: planOnly,
                trust,
            });
            break;
        }
        case "continue": {
            const continueArgs = args.slice(1);
            let dir = ".";
            let model;
            let trust = false;
            for (let i = 0; i < continueArgs.length; i++) {
                switch (continueArgs[i]) {
                    case "--dir":
                        dir = continueArgs[++i];
                        break;
                    case "--model":
                        model = continueArgs[++i];
                        break;
                    case "--trust":
                        trust = true;
                        break;
                }
            }
            await continueBuild(dir, { model, trust });
            break;
        }
        default:
            console.error(`Unknown command: ${command}`);
            printUsage();
            process.exit(1);
    }
}
main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
