import * as catchup from "@/lib/server/assist/catchup";
import * as imports from "@/lib/server/assist/imports";
import * as meetings from "@/lib/server/assist/meetings";
import * as memory from "@/lib/server/assist/memory";
import * as suggest from "@/lib/server/assist/suggest";
import * as tokens from "@/lib/server/assist/tokens";
import { empty, json, withErrors } from "@/lib/server/respond";

// One function for every assist and knowledge-base action, keyed by "METHOD action" — a related
// endpoint is a new action on this dispatcher (src/lib/server/assist/*.ts), not a new route.
// Any miss is 404, including a known action with the wrong method.
const ROUTES = new Map<string, (request: Request) => Promise<Response>>([
  ["POST meeting-open", meetings.handleMeetingOpen],
  ["POST meeting-close", meetings.handleMeetingClose],
  ["GET meetings", meetings.handleMeetingsGet],
  ["POST suggest", suggest.handleSuggest],
  ["POST feedback", suggest.handleFeedback],
  ["GET suggestions", suggest.handleSuggestionsGet],
  ["GET imports", imports.handleImports],
  ["POST begin", imports.handleBegin],
  ["POST browser", imports.handleBrowser],
  ["POST page", imports.handlePage],
  ["POST items", imports.handleItems],
  ["POST finish", imports.handleFinish],
  ["POST remove", imports.handleRemove],
  ["POST gmail-backfill", imports.handleGmailBackfill],
  ["POST distill", imports.handleDistill],
  ["GET memories", memory.handleMemories],
  ["POST forget", memory.handleForget],
  ["POST correct", memory.handleCorrect],
  ["GET profile", imports.handleProfile],
  ["GET recall", memory.handleRecall],
  ["GET containers", memory.handleContainers],
  ["POST remember", memory.handleRemember],
  ["POST token", tokens.handleToken],
  ["POST token-revoke", tokens.handleTokenRevoke],
  ["POST excludes", imports.handleExcludes],
  ["GET excludes", imports.handleExcludesGet],
  ["GET catchup", catchup.handleCatchup],
]);

// The browser extension calls these cross-origin with a bearer token.
const CORS_ACTIONS = new Set(["begin", "browser", "finish", "page", "excludes"]);

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "86400",
};

async function dispatch(request: Request, { params }: { params: Promise<{ action: string }> }): Promise<Response> {
  const { action } = await params;
  const cors = CORS_ACTIONS.has(action);
  if (cors && request.method === "OPTIONS") return empty(204, CORS_HEADERS);

  const handler = ROUTES.get(`${request.method} ${action}`);
  const response = handler ? await withErrors(handler)(request) : json({ error: "not found" }, 404);
  if (cors) for (const [name, value] of Object.entries(CORS_HEADERS)) response.headers.set(name, value);
  return response;
}

export { dispatch as GET, dispatch as POST, dispatch as PUT, dispatch as PATCH, dispatch as DELETE, dispatch as OPTIONS };
