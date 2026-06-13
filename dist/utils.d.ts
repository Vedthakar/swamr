export declare function info(msg: string): void;
export declare function warn(msg: string): void;
export declare function header(msg: string): void;
export declare function bold(msg: string): string;
export declare function run(cmd: string, cwd?: string): string;
export declare function runSafe(cmd: string, cwd?: string): string | null;
export declare function writeFileDeep(filePath: string, content: string): void;
export declare function copyDirRecursive(src: string, dest: string): void;
export declare function commandExists(cmd: string): boolean;
