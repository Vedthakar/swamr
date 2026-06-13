#!/usr/bin/env node

import { init } from "./init.js";

const VERSION = "1.0.0";

function printUsage() {
  console.log(`
swamr v${VERSION} — Agent swarm for Cursor

Usage:
  swamr init [project-dir]    Set up Swamr in a project (default: current dir)
  swamr --version             Show version
  swamr --help                Show this help

Examples:
  swamr init                  Initialize in current directory
  swamr init ./my-app         Initialize in ./my-app (creates if needed)
  npx swamr init              Run without installing globally
`);
}

function main() {
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
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

main();
