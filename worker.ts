// @ts-ignore `.open-next/worker.js` is generated at build time
import { default as handler } from "./.open-next/worker.js";

// Re-exported so the Workflow class ships in this Worker's bundle; wrangler.jsonc binds it by
// class_name and drives it from its own `schedules` entry.
export { SweepWorkflow } from "./sweep-workflow";

export default handler;
