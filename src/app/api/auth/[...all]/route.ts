import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/lib/server/auth-server";

// better-auth owns every /api/auth/* path, including the Polar webhook when billing is on.
const handler = (method: keyof ReturnType<typeof toNextJsHandler>) => (request: Request) => toNextJsHandler(getAuth())[method](request);

export const GET = handler("GET");
export const POST = handler("POST");
export const PATCH = handler("PATCH");
export const PUT = handler("PUT");
export const DELETE = handler("DELETE");
