import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const isTTY = process.stdout.isTTY ?? false;
const GREEN = isTTY ? "\x1b[0;32m" : "";
const YELLOW = isTTY ? "\x1b[1;33m" : "";
const CYAN = isTTY ? "\x1b[0;36m" : "";
const BOLD = isTTY ? "\x1b[1m" : "";
const RESET = isTTY ? "\x1b[0m" : "";
export function info(msg) {
    console.log(`${GREEN}[✓]${RESET} ${msg}`);
}
export function warn(msg) {
    console.log(`${YELLOW}[!]${RESET} ${msg}`);
}
export function header(msg) {
    console.log(`\n${BOLD}${CYAN}${msg}${RESET}`);
}
export function bold(msg) {
    return `${BOLD}${msg}${RESET}`;
}
export function run(cmd, cwd) {
    return execSync(cmd, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
    }).trim();
}
export function runSafe(cmd, cwd) {
    try {
        return run(cmd, cwd);
    }
    catch {
        return null;
    }
}
export function writeFileDeep(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf-8");
}
export function copyDirRecursive(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDirRecursive(srcPath, destPath);
        }
        else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}
export function commandExists(cmd) {
    return runSafe(`which ${cmd}`) !== null;
}
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_MESSAGES = [
    "herding agents into formation",
    "bribing the planner with tokens",
    "teaching bees to code",
    "untangling dependency spaghetti",
    "convincing typescript this is fine",
    "asking politely for no bugs",
    "warming up the hive mind",
    "negotiating with node_modules",
    "summoning 150 tiny engineers",
    "polishing the architecture",
    "whispering to the compiler",
    "counting semicolons nervously",
    "rehearsing error messages",
    "alphabetizing the chaos",
    "calibrating the swarm",
    "consulting the obsidian oracle",
    "drafting a strongly-worded commit",
    "shaking hands with supabase",
    "triple-checking the vibes",
    "feeding the agents coffee",
    "deploying thoughts and prayers",
    "asking claude for a second opinion",
    "translating requirements to english",
    "spinning up parallel universes",
    "defragmenting the plan",
    "crossing fingers in production",
    "stacking contexts carefully",
    "poking the build system",
    "optimizing for good energy",
    "generating plausible excuses",
    "charging the flux capacitor",
    "wrangling rogue promises",
    "putting the fun in functions",
    "aligning the tech stack chakras",
    "reticulating splines",
    "compiling hopes and dreams",
    "shuffling the task deck",
    "making the tests believe in themselves",
    "downloading more ram",
    "reading the room temperature",
];
export class Spinner {
    interval = null;
    frameIndex = 0;
    messageIndex;
    constructor() {
        this.messageIndex = Math.floor(Math.random() * SPINNER_MESSAGES.length);
    }
    start(label) {
        if (!isTTY) {
            if (label)
                console.log(label);
            return;
        }
        this.frameIndex = 0;
        let ticks = 0;
        this.interval = setInterval(() => {
            const frame = SPINNER_FRAMES[this.frameIndex % SPINNER_FRAMES.length];
            const msg = SPINNER_MESSAGES[this.messageIndex % SPINNER_MESSAGES.length];
            const display = label ? `${label} — ${msg}` : msg;
            process.stdout.write(`\r${CYAN}${frame}${RESET} ${display}  `);
            this.frameIndex++;
            ticks++;
            if (ticks % 25 === 0) {
                this.messageIndex = (this.messageIndex + 1 + Math.floor(Math.random() * 3)) % SPINNER_MESSAGES.length;
            }
        }, 80);
    }
    stop(finalMessage) {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
        if (isTTY) {
            process.stdout.write("\r\x1b[K");
        }
        if (finalMessage) {
            info(finalMessage);
        }
    }
}
