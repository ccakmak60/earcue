"use client";

import { useCallback, useEffect, useState } from "react";
import * as connect from "@/lib/client/connect";

// Connection state. Called by the always-mounted app shell (the Sources view renders it and For you
// reads whether anything is connected), so OAuth progress survives view switches.
export function useConnectionSettings() {
  const [features, setFeatures] = useState<connect.ConnectorFeatures>({});
  const [connections, setConnections] = useState<connect.Connection[] | null>(null);
  const enabled = Boolean(features.google || features.slack);

  const refresh = useCallback(async () => {
    try {
      setConnections(await connect.listConnections());
    } catch (err) {
      console.error("connect list failed", err);
    }
  }, []);

  useEffect(() => {
    connect.connectorFeatures().then(setFeatures, () => {});
  }, []);

  useEffect(() => {
    if (enabled) refresh();
  }, [enabled, refresh]);

  return { features, connections, enabled, refresh };
}

export type ConnectionState = ReturnType<typeof useConnectionSettings>;
