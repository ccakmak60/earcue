import * as connect from "@/lib/server/connect";
import { json, withErrors } from "@/lib/server/respond";

export const maxDuration = 60;

// Keyed by "METHOD action"; any miss is 404, including a known action with the wrong method.
const ROUTES = new Map<string, (request: Request) => Promise<Response>>([
  ["GET list", connect.handleList],
  ["GET start", connect.handleStart],
  ["GET callback", connect.handleCallback],
  ["POST sync", connect.handleSync],
  ["POST upload", connect.handleUpload],
  ["POST disconnect", connect.handleDisconnect],
  ["POST whatsapp-link", connect.handleWhatsappLink],
  ["GET whatsapp-status", connect.handleWhatsappStatus],
  ["POST whatsapp-webhook", connect.handleWhatsappWebhook],
]);

async function dispatch(request: Request, { params }: { params: Promise<{ action: string }> }): Promise<Response> {
  if (connect.connectorsDisabled()) return json({ error: "connectors_disabled" }, 501);
  const { action } = await params;
  const handler = ROUTES.get(`${request.method} ${action}`);
  return handler ? withErrors(handler)(request) : json({ error: "not found" }, 404);
}

export { dispatch as GET, dispatch as POST, dispatch as PUT, dispatch as PATCH, dispatch as DELETE, dispatch as OPTIONS };
