// Structural subset of the `cloudflare:workers` runtime module, for the same reason
// src/lib/server/request-scope.ts declares its own R2/Queue shapes: `@cloudflare/workers-types` is
// not a dependency, and `cloudflare-env.d.ts` (npm run cf-typegen) is gitignored, so a checked-out
// tree would not typecheck without this. Only the members sweep-workflow.ts actually calls are here.
declare module "cloudflare:workers" {
  export interface WorkflowEvent<T> {
    payload: T;
    timestamp: Date;
    instanceId: string;
  }

  export interface WorkflowStepConfig {
    retries?: { limit: number; delay: number | string; backoff?: "constant" | "linear" | "exponential" };
    timeout?: number | string;
  }

  export interface WorkflowStep {
    do<T>(name: string, callback: () => Promise<T>): Promise<T>;
    do<T>(name: string, config: WorkflowStepConfig, callback: () => Promise<T>): Promise<T>;
    sleep(name: string, duration: number | string): Promise<void>;
  }

  export abstract class WorkflowEntrypoint<Env = unknown, Params = unknown> {
    protected env: Env;
    protected ctx: unknown;
    abstract run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<unknown>;
  }
}
