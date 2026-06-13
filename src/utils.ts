import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const isTTY = process.stdout.isTTY ?? false;

const GREEN = isTTY ? "\x1b[0;32m" : "";
const YELLOW = isTTY ? "\x1b[1;33m" : "";
const CYAN = isTTY ? "\x1b[0;36m" : "";
const BOLD = isTTY ? "\x1b[1m" : "";
const RESET = isTTY ? "\x1b[0m" : "";

export function info(msg: string) {
  console.log(`${GREEN}[✓]${RESET} ${msg}`);
}

export function warn(msg: string) {
  console.log(`${YELLOW}[!]${RESET} ${msg}`);
}

export function header(msg: string) {
  console.log(`\n${BOLD}${CYAN}${msg}${RESET}`);
}

export function bold(msg: string): string {
  return `${BOLD}${msg}${RESET}`;
}

export function run(cmd: string, cwd?: string): string {
  return execSync(cmd, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

export function runSafe(cmd: string, cwd?: string): string | null {
  try {
    return run(cmd, cwd);
  } catch {
    return null;
  }
}

export function writeFileDeep(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

export function copyDirRecursive(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

export function commandExists(cmd: string): boolean {
  return runSafe(`which ${cmd}`) !== null;
}
