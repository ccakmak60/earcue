import { afterEach, describe, expect, it, vi } from "vitest";
import { SweepWorkflow } from "../../sweep-workflow";

const SWEEP_URL = "https://earcue.lol/api/cron/review-sweep";
const env = { SWEEP_URL, SWEEP_RUN_URL: `${SWEEP_URL}/run`, CRON_SECRET: "secret" };

const event = { payload: undefined, timestamp: new Date(), instanceId: "test" };

interface Task {
  kind: "review" | "distill";
  userId: string;
  tz: string;
}

const reply = (ok: boolean, body: unknown) => ({
  ok,
  status: ok ? 200 : 500,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

// Workflows retries a step body on its own; by the time step.do's promise rejects, the retries are
// spent. Invoking the callback once and letting it reject models exactly that end state.
function recordingStep(elapsedMs = 0) {
  const names: string[] = [];
  return {
    names,
    do: <T>(name: string, callback: () => Promise<T>) => {
      names.push(name);
      if (elapsedMs) vi.advanceTimersByTime(elapsedMs);
      return callback();
    },
  };
}

// Answers the plan GET with `tasks`, then every run POST, failing the ones named in `failing`.
function stubFetch(tasks: Task[], failing: string[] = []) {
  const posted: Task[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      if (url.includes("plan=1")) {
        return reply(true, {
          reviews: tasks.filter((t) => t.kind === "review"),
          distills: tasks.filter((t) => t.kind === "distill"),
        });
      }
      const task = JSON.parse(init?.body ?? "{}") as Task;
      posted.push(task);
      return reply(!failing.includes(task.userId), { error: "boom" });
    })
  );
  return posted;
}

const reviews = (n: number): Task[] =>
  Array.from({ length: n }, (_, i) => ({ kind: "review" as const, userId: `u${i}`, tz: "UTC" }));

afterEach(() => vi.unstubAllGlobals());

describe("SweepWorkflow", () => {
  it("runs the users behind a step that has exhausted its retries", async () => {
    // Twelve tasks is three batches at CONCURRENCY = 5, so a first-batch failure that propagated
    // would strand the seven users in batches two and three.
    const tasks = reviews(12);
    const posted = stubFetch(tasks, ["u1"]);

    await new SweepWorkflow({}, env).run(event, recordingStep());

    expect(posted.map((t) => t.userId)).toEqual(tasks.map((t) => t.userId));
  });

  it("posts every planned task once, reviews before distills", async () => {
    const tasks: Task[] = [
      { kind: "review", userId: "u0", tz: "Europe/Istanbul" },
      { kind: "distill", userId: "u0", tz: "Europe/Istanbul" },
    ];
    const posted = stubFetch(tasks);

    await new SweepWorkflow({}, env).run(event, recordingStep());

    expect(posted).toEqual(tasks);
  });

  it("names each step uniquely so Workflows cannot serve one user another's cached result", async () => {
    // Both tasks belong to u0, so a name keyed on the user alone would collide.
    const tasks: Task[] = [
      { kind: "review", userId: "u0", tz: "UTC" },
      { kind: "distill", userId: "u0", tz: "UTC" },
      { kind: "distill", userId: "u1", tz: "UTC" },
    ];
    stubFetch(tasks);
    const step = recordingStep();

    await new SweepWorkflow({}, env).run(event, step);

    expect(new Set(step.names).size).toBe(step.names.length);
  });

  it("stops fanning out before the next hourly instance would plan the same users", async () => {
    vi.useFakeTimers();
    try {
      const tasks = reviews(15);
      const posted = stubFetch(tasks);
      // 25 minutes a task puts the first batch of five past the 50-minute ceiling on its own, so the
      // ten users behind it are left for the next firing rather than run twice.
      await new SweepWorkflow({}, env).run(event, recordingStep(25 * 60 * 1000));

      expect(posted).toHaveLength(5);
    } finally {
      vi.useRealTimers();
    }
  });
});
