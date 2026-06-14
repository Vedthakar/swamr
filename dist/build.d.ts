export declare function build(targetDir: string, description: string, options?: {
    model?: string;
    plan_only?: boolean;
    trust?: boolean;
}): Promise<void>;
export declare function continueBuild(targetDir: string, options?: {
    model?: string;
    trust?: boolean;
    message?: string;
}): Promise<void>;
/**
 * Adopt an EXISTING project that Swamr did not create. A discovery agent
 * inventories the repo, then the hierarchical planner plans ONLY the remaining
 * work (seeded by `-m`), and the swarm builds from the current state.
 *
 * Differs from `continue`, which resumes an existing swamr/state.json. `adopt`
 * bootstraps a fresh plan from whatever code already exists.
 */
export declare function adoptBuild(targetDir: string, options?: {
    model?: string;
    trust?: boolean;
    message?: string;
}): Promise<void>;
