"use client";

import { useRef, useState } from "react";
import { requestNotifyPermission } from "@/lib/client/assist";
import * as capture from "@/lib/client/capture";
import { useEarcueEvent } from "./use-earcue-event";

// UI state for All day capture. Lives in the always-mounted app shell so counters and the capture pill
// survive view switches; the streams themselves live in src/lib/client/capture.ts.
export function useAmbientCapture(onSynced: () => void) {
  const [running, setRunning] = useState(() => capture.isRunning());
  const [starting, setStarting] = useState(false);
  const [banner, setBanner] = useState("idle");
  const [paused, setPaused] = useState(false);
  const [resumeVisible, setResumeVisible] = useState(false);
  const [counts, setCounts] = useState({ minutes: 0, voiced: 0, synced: 0, pending: 0 });
  const [importStatus, setImportStatus] = useState("");
  const bannerRef = useRef(banner);
  bannerRef.current = banner;

  useEarcueEvent("earcue:chunk", (detail) => {
    setCounts((c) => ({ ...c, minutes: c.minutes + 1, voiced: c.voiced + (detail?.keep ? 1 : 0) }));
    if (bannerRef.current.includes("screen ended")) setResumeVisible(true);
  });
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
      setResumeVisible(false);
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
          : `error: ${e.message}`
      );
    }
    setStarting(false);
  }

  async function togglePause() {
    const next = !paused;
    await capture.setPaused(next);
    setPaused(next);
  }

  async function resumeScreen() {
    await capture.resumeScreen();
    setResumeVisible(false);
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
