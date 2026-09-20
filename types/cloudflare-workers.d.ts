// Structural subset of the `cloudflare:workers` runtime module, for the same reason
// src/lib/server/request-scope.ts declares its own R2/Queue shapes: `@cloudflare/workers-types` is
// not a dependency, and `cloudflare-env.d.ts` (npm run cf-typegen) is gitignored, so a checked-out
// tree would not typecheck without this. Only what this repo actually uses is declared.
declare module "cloudflare:workers" {
  export interface WorkflowEvent<T> {
    payload: T;
    timestamp: Date;
    instanceId: string;
  }

  export interface WorkflowStep {
    do<T>(name: string, callback: () => Promise<T>): Promise<T>;
  }

  export abstract class WorkflowEntrypoint<Env = unknown, Params = unknown> {
    protected env: Env;
    constructor(ctx: unknown, env: Env);
    abstract run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<unknown>;
  }
}
