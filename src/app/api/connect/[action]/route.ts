import * as connect from "@/lib/server/connect";
import { json, withErrors } from "@/lib/server/respond";
import * as services from "@/lib/server/services";

// Keyed by "METHOD action"; any miss is 404, including a known action with the wrong method.
const ROUTES = new Map<string, (request: Request) => Promise<Response>>([
  ["GET list", connect.handleList],
  ["GET start", connect.handleStart],
  ["GET callback", connect.handleCallback],
  ["POST sync", connect.handleSync],
  ["POST upload", connect.handleUpload],
  ["POST disconnect", connect.handleDisconnect],
]);

// Connected services (hosted MCP servers, services.ts): they need only CONNECTOR_ENC_KEY, so they
// answer while the Google and Slack connectors are off.
const SERVICE_ROUTES = new Map<string, (request: Request) => Promise<Response>>([
  ["GET services", services.handleServices],
  ["POST service-connect", services.handleServiceConnect],
  ["GET service-callback", services.handleServiceCallback],
  ["POST service-refresh", services.handleServiceRefresh],
  ["POST service-update", services.handleServiceUpdate],
  ["POST service-disconnect", services.handleServiceDisconnect],
  ["GET service-client", services.handleServiceClient],
]);

async function dispatch(request: Request, { params }: { params: Promise<{ action: string }> }): Promise<Response> {
  const { action } = await params;
  const key = `${request.method} ${action}`;
  if (action.startsWith("service")) {
    if (services.servicesDisabled()) return json({ error: "services_disabled" }, 501);
    const handler = SERVICE_ROUTES.get(key);
    return handler ? withErrors(handler)(request) : json({ error: "not found" }, 404);
  }
  if (connect.connectorsDisabled()) return json({ error: "connectors_disabled" }, 501);
  const handler = ROUTES.get(key);
  return handler ? withErrors(handler)(request) : json({ error: "not found" }, 404);
}

export { dispatch as GET, dispatch as POST, dispatch as PUT, dispatch as PATCH, dispatch as DELETE, dispatch as OPTIONS };
