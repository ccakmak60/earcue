import type { Metadata } from "next";
import { AppShell } from "@/components/app/app-shell";
import { requirePageSession } from "@/lib/server/page-session";

export const metadata: Metadata = { title: { absolute: "Earcue" } };

export default async function AppPage() {
  const session = await requirePageSession();
  return <AppShell email={session.user.email} />;
}
