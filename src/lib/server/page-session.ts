import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "./auth-server";

// Session gate for protected pages (/app, /account). API routes authenticate per request instead.
// headers() is read before getAuth() so `next build` marks the page dynamic instead of prerendering it
// and reading auth env at build time.
export async function requirePageSession() {
  const requestHeaders = await headers();
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  if (!session) redirect("/signin");
  return session;
}
