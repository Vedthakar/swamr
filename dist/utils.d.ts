export declare function info(msg: string): void;
export declare function warn(msg: string): void;
export declare function header(msg: string): void;
export declare function bold(msg: string): string;
export declare function run(cmd: string, cwd?: string, timeoutMs?: number): string;
export declare function runSafe(cmd: string, cwd?: string, timeoutMs?: number): string | null;
export declare function writeFileDeep(filePath: string, content: string): void;
export declare function copyDirRecursive(src: string, dest: string): void;
export declare function commandExists(cmd: string): boolean;
export declare class Spinner {
    private interval;
    private frameIndex;
    private messageIndex;
    constructor();
    start(label?: string): void;
    stop(finalMessage?: string): void;
}
export interface ProgressTask {
    id: string;
    description: string;
}
export declare class ProgressDashboard {
    private interval;
    private frameIndex;
    private messageIndex;
    private renderedLines;
    phase: string;
    phaseIndex: number;
    totalPhases: number;
    phaseCompleted: number;
    phaseTotal: number;
    overallCompleted: number;
    overallTotal: number;
    activeTasks: ProgressTask[];
    wave: number;
    checkpoint: boolean;
    blockedCount: number;
    start(): void;
    private render;
    stop(): void;
}
