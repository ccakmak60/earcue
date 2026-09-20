// `cloudflare:workers` only exists inside workerd, so vitest.config.ts aliases the specifier here the
// same way it aliases `server-only` away. Only the runtime value sweep-workflow.ts imports needs a
// body: WorkflowEvent and WorkflowStep are type-only imports and erase at compile time.
export class WorkflowEntrypoint<Env = unknown> {
  protected env: Env;

  constructor(_ctx: unknown, env: Env) {
    this.env = env;
  }
}
