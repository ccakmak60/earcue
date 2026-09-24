"use client";

import { useCallback, useEffect, useState } from "react";
import * as connect from "@/lib/client/connect";
import * as svc from "@/lib/client/services";

// Connection state: Google and Slack accounts, and connected services (hosted MCP servers). Called
// by the always-mounted app shell (the Sources view renders it and For you reads whether anything
// is connected), so OAuth progress survives view switches.
export function useConnectionSettings() {
  const [features, setFeatures] = useState<connect.ConnectorFeatures>({});
  const [connections, setConnections] = useState<connect.Connection[] | null>(null);
  const [services, setServices] = useState<svc.Service[] | null>(null);
  const enabled = Boolean(features.google || features.slack);

  const refresh = useCallback(async () => {
    try {
      setConnections(await connect.listConnections());
    } catch (err) {
      console.error("connect list failed", err);
    }
  }, []);

  const refreshServices = useCallback(async () => {
    try {
      setServices(await svc.listServices());
    } catch (err) {
      console.error("services list failed", err);
    }
  }, []);

  useEffect(() => {
    connect.connectorFeatures().then(setFeatures, () => {});
  }, []);

  useEffect(() => {
    if (enabled) refresh();
  }, [enabled, refresh]);

  useEffect(() => {
    if (features.services) refreshServices();
  }, [features.services, refreshServices]);

  return { features, connections, enabled, refresh, services, setServices, refreshServices };
}

export type ConnectionState = ReturnType<typeof useConnectionSettings>;
