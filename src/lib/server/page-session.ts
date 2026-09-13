import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "./auth-server";

// Session gate for protected pages (/app, /account). API routes authenticate per request instead.
export async function requirePageSession() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) redirect("/signin");
  return session;
}
