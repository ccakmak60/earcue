"use client";

import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { FieldGroup, Kicker } from "./primitives";
import { SettingsAmbient } from "./settings-ambient";
import { SettingsConnections, useConnectionSettings } from "./settings-connections";
import { SettingsKnowledge, useKnowledgeSettings } from "./settings-knowledge";

// The sheet content unmounts while closed, so section state lives in hooks here: this component stays
// mounted with the app shell, which keeps import progress and a minted token alive and loads the
// knowledge overview at boot.
export function SettingsSheet({
  open,
  onOpenChange,
  retentionDays,
  blocklist,
  onRetentionDays,
  onBlocklist,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  retentionDays: string;
  blocklist: string;
  onRetentionDays: (value: string) => void;
  onBlocklist: (value: string) => void;
}) {
  const connections = useConnectionSettings();
  const knowledge = useKnowledgeSettings();

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="w-[min(560px,calc(100vw-2rem))] gap-0 sm:max-w-[560px]"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement | null)?.querySelector<HTMLInputElement>("#retentionDays")?.focus();
        }}
      >
        <SheetHeader className="border-b">
          <SheetTitle className="text-[13px]">Settings</SheetTitle>
          <SheetDescription className="sr-only">Capture, connections, knowledge and account settings</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-6 overflow-y-auto p-4">
          <SettingsAmbient retentionDays={retentionDays} blocklist={blocklist} onRetentionDays={onRetentionDays} onBlocklist={onBlocklist} />
          <SettingsConnections state={connections} />
          <SettingsKnowledge state={knowledge} />
          <FieldGroup className="min-[821px]:hidden [&_a]:text-sm">
            <Kicker as="h3" className="mb-0">
              Account
            </Kicker>
            <a href="/account">Account &amp; billing</a>
            <a href="/privacy">Privacy</a>
            <a href="/terms">Terms</a>
          </FieldGroup>
        </div>
      </SheetContent>
    </Sheet>
  );
}
