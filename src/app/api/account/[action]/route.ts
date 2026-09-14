import * as account from "@/lib/server/account";
import { json } from "@/lib/server/respond";

// Keyed by action only: each action checks its own method and answers 405 with no body.
const ACTIONS = new Map<string, (request: Request) => Promise<Response>>([
  ["export", account.handleExport],
  ["delete", account.handleDelete],
  ["usage", account.handleUsage],
  ["checkout", account.handleCheckout],
]);

async function dispatch(request: Request, { params }: { params: Promise<{ action: string }> }): Promise<Response> {
  const handler = ACTIONS.get((await params).action);
  return handler ? handler(request) : json({ error: "not found" }, 404);
}

export { dispatch as GET, dispatch as POST, dispatch as PUT, dispatch as PATCH, dispatch as DELETE, dispatch as OPTIONS };
