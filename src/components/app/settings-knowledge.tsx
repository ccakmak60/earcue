"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import * as knowledge from "@/lib/client/knowledge";
import { RECOMMENDED_SKIP_DOMAINS } from "@/lib/shared/pagetext";
import { Chip, Chips, FieldGroup, FieldLabel, Kicker, Note, Row } from "./primitives";

// Knowledge-base state and actions. Called by the always-mounted app shell and handed to the
// Sources, Memory and For you views and the settings sheet, so a long import keeps reporting status
// across view switches and a minted token stays visible after the sheet closes.
export function useKnowledgeSettings() {
  const [overview, setOverview] = useState<knowledge.KnowledgeOverview | null>(null);
  const [memories, setMemories] = useState<knowledge.Memory[] | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState("");
  const [excludes, setExcludes] = useState("");
  const [capturePages, setCapturePages] = useState(true);
  const excludesFocused = useRef(false);
  const savedExcludes = useRef("");

  const refresh = useCallback(async () => {
    let data;
    try {
      data = await knowledge.loadOverview();
    } catch (err) {
      console.error("knowledge imports failed", err);
      return;
    }
    setOverview(data);
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

  // Runs one import-shaped task at a time and reloads the overview after it, success or not, so a
  // failed import still shows up in the list with its error.
  async function run(task: () => Promise<boolean>): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    let ok = false;
    try {
      ok = await task();
    } catch (err) {
      console.error("knowledge task failed", err);
    }
    setBusy(false);
    await refresh();
    return ok;
  }

  const importFile = (file: File) => run(() => knowledge.importFile(file, setStatus));
  const importGmail = () => run(() => knowledge.backfill("gmail", setStatus));

  async function mintToken() {
    try {
      setToken(await knowledge.mintIngestToken());
      await refresh();
    } catch (err) {
      console.error("mint token failed", err);
    }
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
    status,
    setStatus,
    busy,
    token,
    excludes,
    setExcludes,
    excludesFocused,
    commitExcludes,
    refresh,
    importFile,
    importGmail,
    mintToken,
    capturePages,
    toggleCapturePages,
    addRecommendedSkips,
  };
}

export type KnowledgeState = ReturnType<typeof useKnowledgeSettings>;

export function SettingsPrivacy({ state: k }: { state: KnowledgeState }) {
  return (
    <FieldGroup>
      <Kicker as="h3" className="mb-0">
        Privacy
      </Kicker>
      <p className="text-sm text-muted-foreground">
        Health, money, legal and intimate details are marked sensitive when earcue learns them. They stay searchable in Memory but never appear in
        recommendations.
      </p>
      <div>
        <FieldLabel htmlFor="excludedDomains">Never import from these websites (one per line)</FieldLabel>
        <Textarea
          id="excludedDomains"
          placeholder={"mybank.com\nhealthportal.com"}
          value={k.excludes}
          onFocus={() => (k.excludesFocused.current = true)}
          onChange={(e) => k.setExcludes(e.target.value)}
          onBlur={(e) => k.commitExcludes(e.target.value)}
        />
        <Chips>
          <Chip onClick={k.addRecommendedSkips}>Add email, chat and sign-in sites ({RECOMMENDED_SKIP_DOMAINS.length})</Chip>
        </Chips>
      </div>
    </FieldGroup>
  );
}

// Connecting the extension is one click in Sources (lib/client/extension.ts). A token minted here is
// only for pointing it at another earcue address by hand, through its options page.
export function SettingsExtension({ state: k }: { state: KnowledgeState }) {
  return (
    <FieldGroup>
      <Kicker as="h3" className="mb-0">
        Browser extension
      </Kicker>
      <p className="text-sm text-muted-foreground">
        Connect the earcue extension from Sources, under This browser. To point it at another earcue address, paste a token from here into its
        options.
      </p>
      <Button variant="outline" className="self-start" onClick={k.mintToken}>
        Create extension token
      </Button>
      {k.token && <output className="rounded-sm bg-muted p-2 font-mono text-xs break-all">{k.token}</output>}
      <Row action={<Chip aria-pressed={k.capturePages} className="self-start" onClick={k.toggleCapturePages}>{k.capturePages ? "On" : "Off"}</Chip>}>
        Let the extension save the text of pages you read
      </Row>
      <Note>Tokens are shown once. Create a new one if you lose it.</Note>
    </FieldGroup>
  );
}
