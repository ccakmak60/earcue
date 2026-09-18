// @ts-ignore `.open-next/worker.js` is generated at build time
import { default as handler } from "./.open-next/worker.js";
import { runInRequestScope, type WorkerEnv } from "./src/lib/server/request-scope";

export default {
  fetch(request: Request, env: WorkerEnv, ctx: unknown) {
    return runInRequestScope(env, () => handler.fetch(request, env, ctx));
  },
};
