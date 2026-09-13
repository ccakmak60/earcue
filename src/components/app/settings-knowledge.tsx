"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import * as knowledge from "@/lib/client/knowledge";
import { Chip, Chips, Empty, FieldGroup, FieldLabel, Kicker, Note, Row } from "./primitives";

function RemoveButton({ label, onClick }: { label: string; onClick: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="outline"
      className="self-start"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await onClick();
        } catch (err) {
          console.error(`${label} failed`, err);
          setBusy(false);
        }
      }}
    >
      {label}
    </Button>
  );
}

function FileImport({ id, label, accept, run }: { id: string; label: string; accept: string; run: (file: File) => void }) {
  return (
    <div>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <input
        type="file"
        id={id}
        accept={accept}
        className="text-sm"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) run(file);
        }}
      />
    </div>
  );
}

export function SettingsKnowledge() {
  const [overview, setOverview] = useState<knowledge.KnowledgeOverview | null>(null);
  const [memories, setMemories] = useState<knowledge.Memory[] | null>(null);
  const [spaces, setSpaces] = useState<{ container: string; memories: number }[]>([]);
  const [status, setStatus] = useState("");
  const [token, setToken] = useState("");
  const [excludes, setExcludes] = useState("");
  const [query, setQuery] = useState("");
  const [space, setSpace] = useState("");
  const [results, setResults] = useState<knowledge.RecallResult | "hint" | null>(null);
  const excludesFocused = useRef(false);
  const recallTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refresh = useCallback(async () => {
    let data;
    try {
      data = await knowledge.loadOverview();
    } catch (err) {
      console.error("knowledge imports failed", err);
      return;
    }
    setOverview(data);
    knowledge.loadSpaces().then(
      (list) => {
        setSpaces(list);
        setSpace((prev) => (list.some((s) => s.container === prev) ? prev : ""));
      },
      (err) => console.error("knowledge containers failed", err)
    );
    if (!excludesFocused.current) setExcludes((data.excludedDomains || []).join("\n"));
    try {
      setMemories(await knowledge.loadMemories());
    } catch (err) {
      console.error("knowledge memories failed", err);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function afterSuccess(ok: Promise<boolean>) {
    if (await ok) await refresh();
  }

  async function runRecall(rerank: boolean, q = query, container = space) {
    if (!q.trim()) {
      setResults("hint");
      return;
    }
    try {
      setResults(await knowledge.recallMemory(q.trim(), container, rerank));
    } catch (err) {
      console.error("recall failed", err);
      setStatus(`Search failed: ${(err as Error).message}`);
    }
  }

  async function rememberInput() {
    const text = query.trim();
    if (!text) return;
    try {
      const memory = await knowledge.remember(text, space);
      setQuery("");
      setStatus(`Remembered: ${memory.text}`);
      await refresh();
    } catch (err) {
      console.error("remember failed", err);
      setStatus(`Remember failed: ${(err as Error).message}`);
    }
  }

  const profile = overview?.profile;

  return (
    <FieldGroup>
      <Kicker as="h3" className="mb-0">
        Knowledge
      </Kicker>
      <p className="text-sm">{profile?.summary || "No standing profile yet — import something and let it learn."}</p>
      <ul className="flex flex-wrap gap-2 text-xs">
        {(profile?.static || []).map((fact, i) => (
          <li key={i}>{fact}</li>
        ))}
      </ul>
      <ul className="flex flex-wrap gap-2 text-xs">
        {(profile?.dynamic || []).map((fact, i) => (
          <li key={i}>{fact}</li>
        ))}
      </ul>

      <div className="flex flex-col gap-3">
        {overview?.imports.length === 0 && <Empty>No imports yet.</Empty>}
        {overview?.imports.map((imp) => (
          <Row key={imp.id} action={<RemoveButton label="Remove" onClick={() => knowledge.removeImport(imp.id).then(refresh)} />}>
            {imp.source} &middot; {imp.status} &middot; {imp.itemsIngested} items &middot; {new Date(imp.createdAt).toLocaleString()}
            {imp.error ? ` — error: ${imp.error}` : ""}
          </Row>
        ))}
      </div>

      <FileImport id="importBookmarks" label="Import bookmarks (.html)" accept=".html,.htm" run={(f) => afterSuccess(knowledge.importBookmarks(f, setStatus))} />
      <FileImport id="importHistory" label="Import Google Takeout history (.json)" accept=".json" run={(f) => afterSuccess(knowledge.importHistory(f, setStatus))} />
      <FileImport id="importWhatsapp" label="Import WhatsApp chat export (.txt)" accept=".txt" run={(f) => afterSuccess(knowledge.importWhatsapp(f, setStatus))} />

      <Chips>
        <Chip onClick={() => afterSuccess(knowledge.backfill("gmail", setStatus))}>Backfill Gmail</Chip>
        <Chip onClick={() => afterSuccess(knowledge.backfill("whatsapp", setStatus))}>Backfill WhatsApp</Chip>
        <Chip
          onClick={async () => {
            setStatus("Learning…");
            await knowledge.distillLoop(setStatus);
            await refresh();
          }}
        >
          Learn now
        </Chip>
        <Chip
          onClick={async () => {
            try {
              setToken(await knowledge.mintIngestToken());
              await refresh();
            } catch (err) {
              console.error("mint token failed", err);
            }
          }}
        >
          Create extension token
        </Chip>
      </Chips>
      <output className="font-mono text-xs break-all">{token}</output>

      <div>
        <FieldLabel htmlFor="excludedDomains">Never import from (one per line)</FieldLabel>
        <Textarea
          id="excludedDomains"
          placeholder={"bank.example\nhealth.example"}
          value={excludes}
          onFocus={() => (excludesFocused.current = true)}
          onChange={(e) => setExcludes(e.target.value)}
          onBlur={(e) => {
            excludesFocused.current = false;
            knowledge.saveExcludes(e.target.value).catch((err) => console.error("save excludes failed", err));
          }}
        />
      </div>
      <Note>{status}</Note>

      <Chips className="items-center">
        <Input
          type="search"
          aria-label="Search your memory"
          placeholder="Search your memory"
          className="max-w-60"
          value={query}
          onChange={(e) => {
            const q = e.target.value;
            setQuery(q);
            clearTimeout(recallTimer.current);
            recallTimer.current = setTimeout(() => runRecall(false, q), 400);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              runRecall(true);
            }
          }}
        />
        <select
          aria-label="Memory space"
          value={space}
          onChange={(e) => {
            setSpace(e.target.value);
            runRecall(false, query, e.target.value);
          }}
          className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
        >
          <option value="">All spaces</option>
          {spaces.map((s) => (
            <option key={s.container} value={s.container}>
              {s.container} ({s.memories})
            </option>
          ))}
        </select>
        <Chip onClick={() => runRecall(true)}>Recall</Chip>
        <Chip onClick={rememberInput}>Remember this</Chip>
      </Chips>

      <div className="flex flex-col gap-3 text-sm">
        {results === "hint" && <Empty>Type to search your memory.</Empty>}
        {results && results !== "hint" && results.memories.length === 0 && results.documents.length === 0 && <Empty>Nothing in memory matches that yet.</Empty>}
        {results &&
          results !== "hint" &&
          results.memories.map((mem) => (
            <div key={mem.id}>
              <div>
                {mem.kind} &middot; {mem.container} &mdash; {mem.text}
              </div>
              {results.related
                .filter((r) => r.src_id === mem.id || r.dst_id === mem.id)
                .map((rel, i) => (
                  <Note key={i}>
                    {rel.relation} &rarr; {rel.subject}
                  </Note>
                ))}
            </div>
          ))}
        {results && results !== "hint" && results.documents.length > 0 && (
          <>
            <h4 className="font-medium">From your archive (all sources)</h4>
            {results.documents.map((doc, i) =>
              doc.url ? (
                <a key={i} href={doc.url} target="_blank" rel="noopener" className="underline">
                  {doc.provider} &middot; {doc.title}
                </a>
              ) : (
                <div key={i}>
                  {doc.provider} &middot; {doc.title}
                </div>
              )
            )}
          </>
        )}
      </div>

      <div className="flex flex-col gap-3">
        {memories?.length === 0 && <Empty>No memories yet.</Empty>}
        {memories?.map((mem) => (
          <Row key={mem.id} action={<RemoveButton label="Forget" onClick={() => knowledge.forgetMemory(mem.id).then(refresh)} />}>
            {mem.kind} &middot; {mem.container} &middot; {mem.text} (strength {Number(mem.strength).toFixed(2)})
          </Row>
        ))}
      </div>

      <Note>
        The browser extension keeps history and bookmarks flowing continuously. It lives in <code>extension/</code> and is loaded via chrome://extensions &rarr;
        Developer mode &rarr; Load unpacked, then configured with a token minted above.
      </Note>
    </FieldGroup>
  );
}
