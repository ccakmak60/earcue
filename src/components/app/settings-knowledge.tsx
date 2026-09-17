"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import * as knowledge from "@/lib/client/knowledge";
import { RECOMMENDED_SKIP_DOMAINS } from "@/lib/shared/pagetext";
import { Chip, Chips, Empty, FieldGroup, FieldLabel, Kicker, Note, Row } from "./primitives";

// Knowledge-base state and actions; called by the always-mounted settings sheet so long imports keep
// reporting status and a minted token stays visible after the sheet closes.
export function useKnowledgeSettings() {
  const [overview, setOverview] = useState<knowledge.KnowledgeOverview | null>(null);
  const [memories, setMemories] = useState<knowledge.Memory[] | null>(null);
  const [spaces, setSpaces] = useState<{ container: string; memories: number }[]>([]);
  const [status, setStatus] = useState("");
  const [token, setToken] = useState("");
  const [excludes, setExcludes] = useState("");
  const [capturePages, setCapturePages] = useState(true);
  const [query, setQuery] = useState("");
  const [space, setSpace] = useState("");
  const [results, setResults] = useState<knowledge.RecallResult | "hint" | null>(null);
  const excludesFocused = useRef(false);
  const savedExcludes = useRef("");
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
    if (!excludesFocused.current) {
      savedExcludes.current = (data.excludedDomains || []).join("\n");
      setExcludes(savedExcludes.current);
    }
    try {
      setMemories(await knowledge.loadMemories());
    } catch (err) {
      console.error("knowledge memories failed", err);
    }
    try {
      setCapturePages((await knowledge.loadExcludes()).capturePages);
    } catch (err) {
      console.error("knowledge excludes failed", err);
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

  function search(q: string) {
    setQuery(q);
    clearTimeout(recallTimer.current);
    recallTimer.current = setTimeout(() => runRecall(false, q), 400);
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

  async function mintToken() {
    try {
      setToken(await knowledge.mintIngestToken());
      await refresh();
    } catch (err) {
      console.error("mint token failed", err);
    }
  }

  async function learnNow() {
    setStatus("Learning…");
    await knowledge.distillLoop(setStatus);
    await refresh();
  }

  // Saved when the field is committed, and only if it changed.
  function commitExcludes(value: string) {
    excludesFocused.current = false;
    if (value === savedExcludes.current) return;
    savedExcludes.current = value;
    knowledge.saveExcludes(value).catch((err) => console.error("save excludes failed", err));
  }

  async function toggleCapturePages() {
    const next = !capturePages;
    setCapturePages(next);
    try {
      await knowledge.saveCapturePages(next);
    } catch (err) {
      console.error("save capture pages failed", err);
      setCapturePages(!next);
    }
  }

  function addRecommendedSkips() {
    const current = excludes
      .split(/[\n,]/)
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
    const merged = [...current, ...RECOMMENDED_SKIP_DOMAINS].filter((d, i, a) => a.indexOf(d) === i);
    const value = merged.join("\n");
    setExcludes(value);
    commitExcludes(value);
  }

  return {
    overview,
    memories,
    spaces,
    status,
    setStatus,
    token,
    excludes,
    setExcludes,
    excludesFocused,
    commitExcludes,
    query,
    space,
    setSpace,
    results,
    refresh,
    afterSuccess,
    runRecall,
    search,
    rememberInput,
    mintToken,
    learnNow,
    capturePages,
    toggleCapturePages,
    addRecommendedSkips,
  };
}

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

export function SettingsKnowledge({ state: k }: { state: ReturnType<typeof useKnowledgeSettings> }) {
  const profile = k.overview?.profile;
  const results = k.results;

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
        {k.overview?.imports.length === 0 && <Empty>No imports yet.</Empty>}
        {k.overview?.imports.map((imp) => (
          <Row key={imp.id} action={<RemoveButton label="Remove" onClick={() => knowledge.removeImport(imp.id).then(k.refresh)} />}>
            {imp.source} &middot; {imp.status} &middot; {imp.itemsIngested} items &middot; {new Date(imp.createdAt).toLocaleString()}
            {imp.error ? ` — error: ${imp.error}` : ""}
          </Row>
        ))}
      </div>

      <FileImport id="importBookmarks" label="Import bookmarks (.html)" accept=".html,.htm" run={(f) => k.afterSuccess(knowledge.importBookmarks(f, k.setStatus))} />
      <FileImport
        id="importHistory"
        label="Import Google Takeout history (.json)"
        accept=".json"
        run={(f) => k.afterSuccess(knowledge.importHistory(f, k.setStatus))}
      />
      <FileImport id="importWhatsapp" label="Import WhatsApp chat export (.txt)" accept=".txt" run={(f) => k.afterSuccess(knowledge.importWhatsapp(f, k.setStatus))} />

      <Chips>
        <Chip onClick={() => k.afterSuccess(knowledge.backfill("gmail", k.setStatus))}>Backfill Gmail</Chip>
        <Chip onClick={() => k.afterSuccess(knowledge.backfill("whatsapp", k.setStatus))}>Backfill WhatsApp</Chip>
        <Chip onClick={k.learnNow}>Learn now</Chip>
        <Chip onClick={k.mintToken}>Create extension token</Chip>
      </Chips>
      <output className="font-mono text-xs break-all">{k.token}</output>

      <Row action={<Chip aria-pressed={k.capturePages} onClick={k.toggleCapturePages}>{k.capturePages ? "On" : "Off"}</Chip>}>
        Capture page text you read into the archive
      </Row>

      <div>
        <FieldLabel htmlFor="excludedDomains">Never import from (one per line)</FieldLabel>
        <Textarea
          id="excludedDomains"
          placeholder={"bank.example\nhealth.example"}
          value={k.excludes}
          onFocus={() => (k.excludesFocused.current = true)}
          onChange={(e) => k.setExcludes(e.target.value)}
          onBlur={(e) => k.commitExcludes(e.target.value)}
        />
        <Chips>
          <Chip onClick={k.addRecommendedSkips}>Add recommended skips ({RECOMMENDED_SKIP_DOMAINS.length})</Chip>
        </Chips>
      </div>
      <Note>{k.status}</Note>

      <Chips className="items-center">
        <Input
          type="search"
          aria-label="Search your memory"
          placeholder="Search your memory"
          className="max-w-60"
          value={k.query}
          onChange={(e) => k.search(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              k.runRecall(true);
            }
          }}
        />
        <select
          aria-label="Memory space"
          value={k.space}
          onChange={(e) => {
            k.setSpace(e.target.value);
            k.runRecall(false, k.query, e.target.value);
          }}
          className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
        >
          <option value="">All spaces</option>
          {k.spaces.map((s) => (
            <option key={s.container} value={s.container}>
              {s.container} ({s.memories})
            </option>
          ))}
        </select>
        <Chip onClick={() => k.runRecall(true)}>Recall</Chip>
        <Chip onClick={k.rememberInput}>Remember this</Chip>
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
            {results.documents.map((doc, i) => (
              <div key={i}>
                {doc.url ? (
                  <a href={doc.url} target="_blank" rel="noopener" className="underline">
                    {doc.provider} &middot; {doc.title}
                  </a>
                ) : (
                  <span>
                    {doc.provider} &middot; {doc.title}
                  </span>
                )}
                {doc.snippet && (
                  <Note>
                    {doc.snippet.split(/<\/?b>/).map((part, j) => (j % 2 === 1 ? <mark key={j}>{part}</mark> : part))}
                  </Note>
                )}
              </div>
            ))}
          </>
        )}
      </div>

      <div className="flex flex-col gap-3">
        {k.memories?.length === 0 && <Empty>No memories yet.</Empty>}
        {k.memories?.map((mem) => (
          <Row key={mem.id} action={<RemoveButton label="Forget" onClick={() => knowledge.forgetMemory(mem.id).then(k.refresh)} />}>
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
