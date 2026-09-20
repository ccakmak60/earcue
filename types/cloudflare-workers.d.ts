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

// Structural subset of the Queues consumer surface used by infra/task-consumer/src/index.ts.
// Same reason as above: no `@cloudflare/workers-types` dependency, so declare only what is called.
interface Message<Body = unknown> {
  readonly body: Body;
  ack(): void;
  retry(): void;
}

interface MessageBatch<Body = unknown> {
  readonly queue: string;
  readonly messages: readonly Message<Body>[];
}

interface ExportedHandler<Env = unknown> {
  fetch?(request: Request, env: Env, ctx: unknown): Response | Promise<Response>;
  queue?(batch: MessageBatch<unknown>, env: Env, ctx?: unknown): void | Promise<void>;
}
