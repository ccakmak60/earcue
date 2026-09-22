"use client";

import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { CAPTURE_ENABLED } from "@/lib/shared/features";
import { FieldGroup, Kicker } from "./primitives";
import { SettingsAmbient } from "./settings-ambient";
import { type KnowledgeState, SettingsExtension, SettingsPrivacy } from "./settings-knowledge";

// The sheet content unmounts while closed, so section state lives in hooks the app shell owns and
// passes in: a minted token and an in-progress save survive closing the sheet.
export function SettingsSheet({
  open,
  onOpenChange,
  knowledge,
  retentionDays,
  blocklist,
  onRetentionDays,
  onBlocklist,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  knowledge: KnowledgeState;
  retentionDays: string;
  blocklist: string;
  onRetentionDays: (value: string) => void;
  onBlocklist: (value: string) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="w-[min(560px,calc(100vw-2rem))] gap-0 sm:max-w-[560px]"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>(CAPTURE_ENABLED ? "#retentionDays" : "#excludedDomains")?.focus();
        }}
      >
        <SheetHeader className="border-b">
          <SheetTitle className="text-[13px]">Settings</SheetTitle>
          <SheetDescription className="sr-only">Privacy, browser extension and account settings</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-8 overflow-y-auto p-4">
          <SettingsPrivacy state={knowledge} />
          {CAPTURE_ENABLED && <SettingsAmbient retentionDays={retentionDays} blocklist={blocklist} onRetentionDays={onRetentionDays} onBlocklist={onBlocklist} />}
          <SettingsExtension state={knowledge} />
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
