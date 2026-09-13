"use client";

import { useEffect, useRef } from "react";
import { listen, type EarcueEventName, type EarcueEvents } from "@/lib/client/events";

// Subscribes for the component's lifetime; the latest handler always runs without resubscribing.
export function useEarcueEvent<K extends EarcueEventName>(name: K, handler: (detail: EarcueEvents[K]) => void): void {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => listen(name, (detail) => ref.current(detail)), [name]);
}
