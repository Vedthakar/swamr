export declare function build(targetDir: string, description: string, options?: {
    model?: string;
    plan_only?: boolean;
    trust?: boolean;
}): Promise<void>;
export declare function continueBuild(targetDir: string, options?: {
    model?: string;
    trust?: boolean;
}): Promise<void>;
