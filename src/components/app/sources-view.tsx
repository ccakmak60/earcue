"use client";

import { useRef, useState } from "react";
import {
  BookmarkIcon,
  CheckIcon,
  FileTextIcon,
  GlobeIcon,
  HashIcon,
  HistoryIcon,
  Loader2Icon,
  MailIcon,
  MessageCircleIcon,
  UploadIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import * as connect from "@/lib/client/connect";
import { ACCEPTED_FILES, type ImportRecord } from "@/lib/client/knowledge";
import * as knowledge from "@/lib/client/knowledge";
import { cn } from "@/lib/utils";
import { Card, CardGrid, ConfirmButton, EmptyState, IconTile, Kicker, Note, StatusLine, ViewSection, ViewTitle } from "./primitives";
import { ServicesSection } from "./services-section";
import type { ConnectionState } from "./settings-connections";
import type { KnowledgeState } from "./settings-knowledge";

type Icon = React.ComponentType<{ className?: string }>;

export const SOURCE_META: Record<string, { label: string; icon: Icon }> = {
  whatsapp: { label: "WhatsApp", icon: MessageCircleIcon },
  browser_bookmarks: { label: "Bookmarks", icon: BookmarkIcon },
  browser_history: { label: "Browsing history", icon: HistoryIcon },
  browser_pages: { label: "Pages you read", icon: GlobeIcon },
  gmail_backfill: { label: "Gmail", icon: MailIcon },
  doc: { label: "Document", icon: FileTextIcon },
};

function itemsFor(imports: ImportRecord[] | undefined, source: string): number {
  return (imports || []).filter((i) => i.source === source).reduce((n, i) => n + (i.itemsIngested || 0), 0);
}

function Help({ title, steps }: { title: string; steps: React.ReactNode[] }) {
  return (
    <details className="group text-sm">
      <summary className="cursor-pointer list-none text-muted-foreground underline-offset-4 hover:text-foreground hover:underline [&::-webkit-details-marker]:hidden">
        {title}
      </summary>
      <ol className="mt-2 flex list-decimal flex-col gap-1 pl-5 text-muted-foreground">
        {steps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
    </details>
  );
}

function SourceTile({
  icon,
  name,
  status,
  done = false,
  children,
}: {
  icon: Icon;
  name: string;
  status: string;
  done?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card className="flex flex-col gap-3 [&_p]:mb-0">
      <div className="flex items-center gap-3">
        <IconTile icon={icon} />
        <div className="min-w-0">
          <h3 className="text-sm font-medium">{name}</h3>
          <div className="flex items-start gap-1 text-xs text-muted-foreground">
            {done && <CheckIcon className="mt-0.5 size-3 flex-none text-foreground" aria-hidden="true" />}
            <span className="break-words">{status}</span>
          </div>
        </div>
      </div>
      {children}
    </Card>
  );
}

function ConnectTile({
  provider,
  icon,
  name,
  blurb,
  available,
  connection,
  onChange,
  extra,
}: {
  provider: "google" | "slack";
  icon: Icon;
  name: string;
  blurb: string;
  available: boolean;
  connection: connect.Connection | undefined;
  onChange: () => void;
  extra?: React.ReactNode;
}) {
  const status = connection
    ? `Connected${connection.accountLabel ? ` as ${connection.accountLabel}` : ""} · ${connection.itemCount.toLocaleString()} items`
    : available
      ? "Not connected"
      : "Coming soon";
  return (
    <SourceTile icon={icon} name={name} status={status} done={Boolean(connection)}>
      <p className="text-sm text-muted-foreground">{blurb}</p>
      {connection?.lastError && <p className="text-sm text-destructive">Last sync failed: {connection.lastError}</p>}
      <div className="mt-auto flex flex-wrap gap-2">
        {!connection && (
          <Button size="sm" variant={available ? "default" : "outline"} disabled={!available} onClick={() => connect.startOAuth(provider)}>
            {available ? `Connect ${provider === "google" ? "Google" : "Slack"}` : "Coming soon"}
          </Button>
        )}
        {connection && extra}
        {connection && (
          <ConfirmButton
            label="Disconnect"
            title={`Disconnect ${name}?`}
            description={`earcue stops reading ${name} and deletes the items it imported from it.`}
            confirmLabel="Disconnect"
            onConfirm={async () => {
              await connect.disconnect(provider);
              onChange();
            }}
          />
        )}
      </div>
    </SourceTile>
  );
}

function UploadTile({
  icon,
  name,
  blurb,
  count,
  accept,
  busy,
  onFile,
  help,
  extra,
}: {
  icon: Icon;
  name: string;
  blurb: string;
  count: number;
  accept: string;
  busy: boolean;
  onFile: (file: File) => void;
  help: { title: string; steps: React.ReactNode[] };
  extra?: React.ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <SourceTile icon={icon} name={name} status={count > 0 ? `${count.toLocaleString()} items added` : "Nothing added yet"} done={count > 0}>
      <p className="text-sm text-muted-foreground">{blurb}</p>
      <Help {...help} />
      {extra}
      <div className="mt-auto">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => input.current?.click()}>
          <UploadIcon aria-hidden="true" />
          Upload
        </Button>
        <input
          ref={input}
          type="file"
          accept={accept}
          className="hidden"
          aria-label={`Upload ${name}`}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) onFile(file);
          }}
        />
      </div>
    </SourceTile>
  );
}

function DropZone({ busy, status, onFile }: { busy: boolean; status: string; onFile: (file: File) => void }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const file = e.dataTransfer.files?.[0];
        if (file && !busy) onFile(file);
      }}
      className={cn(
        "flex flex-col items-center gap-3 rounded-lg border border-dashed border-input px-6 py-8 text-center transition-[background-color,border-color] duration-150 ease-out",
        over && "border-foreground bg-card"
      )}
    >
      <IconTile icon={busy ? Loader2Icon : UploadIcon} className={cn("size-10", busy && "[&_svg]:animate-spin")} />
      <div>
        <p className="font-medium">Drop any export here</p>
        <p className="mt-1 text-sm text-muted-foreground">WhatsApp chats, bookmarks, Google Takeout history, or notes and documents. earcue works out what it is.</p>
      </div>
      <Button disabled={busy} onClick={() => input.current?.click()}>
        Choose a file
      </Button>
      <input
        ref={input}
        type="file"
        accept={ACCEPTED_FILES}
        className="hidden"
        aria-label="Choose a file to import"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) onFile(file);
        }}
      />
      {status && <StatusLine busy={busy}>{status}</StatusLine>}
    </div>
  );
}

// Which WhatsApp speaker is the person (memory architecture plan, "Per source"): the ones in every
// exported chat are offered once, and the answer makes that name theirs, so earcue can tell what
// they wrote from what they were sent.
function WhatsappSelfQuestion({ self, onConfirmed }: { self: knowledge.WhatsappSelf | undefined; onConfirmed: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!self || self.chats === 0) return null;
  if (self.confirmed) return <Note>You&apos;re {self.confirmed} in these chats.</Note>;
  if (self.candidates.length === 0) return null;
  const candidates = [...self.candidates].sort((a, b) => Number(b.suggested) - Number(a.suggested));

  async function confirm(name: string) {
    setBusy(true);
    setError("");
    try {
      await knowledge.confirmWhatsappSelf(name);
      onConfirmed();
    } catch (err) {
      console.error("whatsapp self failed", err);
      setError("Couldn't save that. Try again in a moment.");
    }
    setBusy(false);
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">Which one is you in these chats?</p>
      <div className="flex flex-wrap gap-2">
        {candidates.map((c) => (
          <Button key={c.name} size="sm" variant={c.suggested ? "default" : "outline"} disabled={busy} onClick={() => confirm(c.name)}>
            I&apos;m {c.name}
          </Button>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function ImportRow({ imp, onRemoved }: { imp: ImportRecord; onRemoved: () => void }) {
  const meta = SOURCE_META[imp.source] || { label: imp.source, icon: FileTextIcon };
  const label = imp.source === "gmail_backfill" ? "Past emails" : imp.label || meta.label;
  const error = imp.error === "quota" ? "today's import limit was reached" : imp.error;
  const when = new Date(imp.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  return (
    <li className="flex items-center gap-3 p-3">
      <IconTile icon={meta.icon} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">
          {meta.label} · {imp.itemsIngested.toLocaleString()} items · {when}
          {imp.status === "running" && " · adding…"}
        </div>
        {imp.status === "failed" && <div className="text-xs text-destructive">Didn&apos;t finish{error ? `: ${error}` : ""}</div>}
      </div>
      <ConfirmButton
        label="Remove"
        title={`Remove ${label}?`}
        description="This deletes the imported items and anything earcue learned only from them. It can't be undone."
        confirmLabel="Remove"
        onConfirm={async () => {
          await knowledge.removeImport(imp.id);
          onRemoved();
        }}
      />
    </li>
  );
}

export function SourcesView({
  active,
  knowledge: k,
  connections: c,
  onImported,
}: {
  active: boolean;
  knowledge: KnowledgeState;
  connections: ConnectionState;
  onImported: () => void;
}) {
  const imports = k.overview?.imports;
  const google = c.connections?.find((x) => x.provider === "google");
  const slack = c.connections?.find((x) => x.provider === "slack");

  async function add(file: File) {
    if (await k.importFile(file)) onImported();
  }

  return (
    <ViewSection active={active} labelledBy="sourcesTitle">
      <header>
        <ViewTitle id="sourcesTitle">Sources</ViewTitle>
        <p className="mt-2 max-w-[34rem] text-sm leading-relaxed text-muted-foreground">
          Everything earcue knows comes from what you add here. Remove a source at any time and what earcue learned from it goes with it.
        </p>
      </header>

      <DropZone busy={k.busy} status={k.status} onFile={add} />

      <section aria-labelledby="connectHeading" className="flex flex-col gap-3">
        <Kicker as="h2" className="mb-0">
          <span id="connectHeading">Connect an account</span>
        </Kicker>
        <CardGrid>
          <ConnectTile
            provider="google"
            icon={MailIcon}
            name="Gmail & Calendar"
            blurb="Recent email and upcoming events, so earcue can spot replies you owe and meetings to prepare for."
            available={Boolean(c.features.google)}
            connection={google}
            onChange={c.refresh}
            extra={
              <Button
                size="sm"
                variant="outline"
                disabled={k.busy}
                onClick={async () => {
                  if (await k.importGmail()) onImported();
                }}
              >
                Import past emails
              </Button>
            }
          />
          <ConnectTile
            provider="slack"
            icon={HashIcon}
            name="Slack"
            blurb="Channels and direct messages you're part of, read-only."
            available={Boolean(c.features.slack)}
            connection={slack}
            onChange={c.refresh}
          />
        </CardGrid>
      </section>

      <ServicesSection connections={c} />

      <section aria-labelledby="uploadHeading" className="flex flex-col gap-3">
        <Kicker as="h2" className="mb-0">
          <span id="uploadHeading">Upload an export</span>
        </Kicker>
        <CardGrid>
          <UploadTile
            icon={MessageCircleIcon}
            name="WhatsApp chats"
            blurb="One chat at a time. Messages stay text only; photos and voice notes are left out."
            count={itemsFor(imports, "whatsapp")}
            accept=".zip,.txt"
            busy={k.busy}
            onFile={add}
            extra={<WhatsappSelfQuestion self={k.overview?.whatsappSelf} onConfirmed={k.refresh} />}
            help={{
              title: "How do I export a chat?",
              steps: [
                "Open the chat in WhatsApp on your phone.",
                <>
                  Tap the contact or group name, then <strong>Export chat</strong> (on Android: ⋮ → More → Export chat).
                </>,
                <>
                  Choose <strong>Without media</strong> and save or email the file to yourself.
                </>,
                "Upload the .zip or .txt file here.",
              ],
            }}
          />
          <UploadTile
            icon={BookmarkIcon}
            name="Bookmarks"
            blurb="The pages you saved on purpose tell earcue what you care about."
            count={itemsFor(imports, "browser_bookmarks")}
            accept=".html,.htm"
            busy={k.busy}
            onFile={add}
            help={{
              title: "How do I export bookmarks?",
              steps: [
                <>
                  <strong>Chrome or Edge:</strong> open the bookmark manager (Ctrl+Shift+O, or ⌘+Shift+O on Mac), then ⋮ → Export bookmarks.
                </>,
                <>
                  <strong>Safari:</strong> File → Export → Bookmarks.
                </>,
                <>
                  <strong>Firefox:</strong> Bookmarks → Manage bookmarks → Import and Backup → Export Bookmarks to HTML.
                </>,
                "Upload the .html file here.",
              ],
            }}
          />
          <UploadTile
            icon={HistoryIcon}
            name="Browsing history"
            blurb="What you actually read, so recommendations follow your real interests."
            count={itemsFor(imports, "browser_history")}
            accept=".zip,.json"
            busy={k.busy}
            onFile={add}
            help={{
              title: "How do I get my history?",
              steps: [
                <>
                  Go to{" "}
                  <a href="https://takeout.google.com" target="_blank" rel="noopener noreferrer" className="underline">
                    takeout.google.com
                  </a>{" "}
                  and click <strong>Deselect all</strong>.
                </>,
                <>
                  Tick <strong>Chrome</strong>, then <strong>Next step</strong> → <strong>Create export</strong>.
                </>,
                "When Google emails you, download the .zip.",
                "Upload the .zip here as it is. No need to unzip it.",
              ],
            }}
          />
          <UploadTile
            icon={FileTextIcon}
            name="Notes & documents"
            blurb="Plain text, Markdown or CSV: journals, meeting notes, reading lists."
            count={itemsFor(imports, "doc")}
            accept=".txt,.md,.csv"
            busy={k.busy}
            onFile={add}
            help={{
              title: "Which files work?",
              steps: [
                "Text (.txt), Markdown (.md) and spreadsheets saved as CSV (.csv).",
                "From Google Docs or Word: File → Download → Plain text.",
                "Up to 40 MB per file.",
              ],
            }}
          />
        </CardGrid>
      </section>

      <section aria-labelledby="addedHeading" className="flex flex-col gap-3 pb-6">
        <Kicker as="h2" className="mb-0">
          <span id="addedHeading">Added so far</span>
        </Kicker>
        {imports?.length === 0 && <EmptyState icon={UploadIcon} title="Nothing added yet." hint="Your first source takes about a minute. WhatsApp or Gmail tend to give the best recommendations." />}
        {imports && imports.length > 0 && (
          <ul className="divide-y rounded-lg border bg-card">
            {imports.map((imp) => (
              <ImportRow key={imp.id} imp={imp} onRemoved={k.refresh} />
            ))}
          </ul>
        )}
        <Note>
          Imported text is stored with your account and processed by Azure OpenAI so earcue can learn from it. See{" "}
          <a href="/privacy" className="underline">
            privacy
          </a>
          .
        </Note>
      </section>
    </ViewSection>
  );
}
