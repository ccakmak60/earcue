"use client";

import { useState } from "react";
import { requestNotifyPermission } from "@/lib/client/assist";
import { runCatchup } from "@/lib/client/catchup";
import * as capture from "@/lib/client/capture";
import { useEarcueEvent } from "./use-earcue-event";

// UI state for All day capture. Lives in the always-mounted app shell so counters and the capture pill
// survive view switches; the streams themselves live in src/lib/client/capture.ts.
export function useAmbientCapture(onSynced: () => void) {
  const [running, setRunning] = useState(() => capture.isRunning());
  const [starting, setStarting] = useState(false);
  const [banner, setBanner] = useState("Not capturing");
  const [paused, setPaused] = useState(false);
  const [resumeVisible, setResumeVisible] = useState(false);
  const [counts, setCounts] = useState({ minutes: 0, voiced: 0, synced: 0, pending: 0 });
  const [importStatus, setImportStatus] = useState("");
  useEarcueEvent("earcue:chunk", (detail) => {
    setCounts((c) => ({ ...c, minutes: c.minutes + 1, voiced: c.voiced + (detail?.keep ? 1 : 0) }));
  });
  useEarcueEvent("earcue:screenended", () => setResumeVisible(true));
  useEarcueEvent("earcue:synced", (detail) => {
    setCounts((c) => ({ ...c, synced: c.synced + (detail.inserted || 0) }));
    onSynced();
  });
  useEarcueEvent("earcue:pending", (detail) => {
    setCounts((c) => ({ ...c, pending: detail.pendingCount || 0 }));
  });

  async function toggle() {
    if (running) {
      capture.stopAmbient();
      setRunning(false);
      setPaused(false);
      setResumeVisible(false);
      void runCatchup();
      return;
    }
    setStarting(true);
    try {
      await capture.startAmbient(setBanner);
      requestNotifyPermission();
      setRunning(true);
      setResumeVisible(false);
    } catch (err) {
      const e = err as Error;
      setBanner(
        e.name === "NotAllowedError"
          ? "Microphone or screen-share permission denied. Allow access in your browser's site settings and try again."
          : `Capture error: ${e.message}`
      );
    }
    setStarting(false);
  }

  async function togglePause() {
    const next = !paused;
    try {
      await capture.setPaused(next);
      setPaused(next);
    } catch (err) {
      console.error("toggle pause failed", err);
    }
  }

  async function resumeScreen() {
    try {
      await capture.resumeScreen();
      setResumeVisible(false);
    } catch (err) {
      console.error("resume screen failed", err);
      setBanner("Screen share not resumed — click Resume screen to try again.");
    }
  }

  async function importRecording(file: File) {
    setImportStatus("Importing…");
    try {
      const result = await capture.importRecording(file);
      setImportStatus(`Imported ${result.rows} line(s) from a ${Math.round(result.durationMs / 1000)}s recording.`);
    } catch (err) {
      setImportStatus((err as Error).message || "Import failed.");
    }
  }

  return { running, starting, banner, paused, resumeVisible, counts, importStatus, toggle, togglePause, resumeScreen, importRecording };
}

export type AmbientCapture = ReturnType<typeof useAmbientCapture>;
