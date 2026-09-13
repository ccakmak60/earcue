"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import * as connect from "@/lib/client/connect";
import { Chip, Chips, Empty, FieldGroup, FieldLabel, Kicker, Note, Row } from "./primitives";

function ConnectionRow({ conn, onChange }: { conn: connect.Connection; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const label = connect.PROVIDER_LABEL[conn.provider] || conn.provider;
  const synced = conn.lastSyncedAt ? new Date(conn.lastSyncedAt).toLocaleString() : "never";
  return (
    <Row
      action={
        <Button
          variant="outline"
          className="self-start"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await connect.disconnect(conn.provider);
              onChange();
            } catch (err) {
              console.error("disconnect failed", err);
              setBusy(false);
            }
          }}
        >
          Disconnect
        </Button>
      }
    >
      {label}
      {conn.accountLabel ? ` — ${conn.accountLabel}` : ""} &mdash; {conn.itemCount} items &mdash; last synced {synced}
      {conn.lastError ? ` — error: ${conn.lastError}` : ""}
    </Row>
  );
}

// Shown only when /api/health reports at least one connector configured.
export function SettingsConnections() {
  const [features, setFeatures] = useState<connect.ConnectorFeatures>({});
  const [connections, setConnections] = useState<connect.Connection[] | null>(null);
  const [whatsapp, setWhatsapp] = useState<connect.WhatsappProgress | null>(null);
  const enabled = Boolean(features.google || features.slack || features.whatsapp);

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

  if (!enabled) return null;

  return (
    <FieldGroup>
      <Kicker as="h3" className="mb-0">
        Connections
      </Kicker>
      <div className="flex flex-col gap-3">
        {connections?.length === 0 && <Empty>No connections yet.</Empty>}
        {connections?.map((c) => (
          <ConnectionRow key={c.provider} conn={c} onChange={refresh} />
        ))}
      </div>
      <Chips>
        {features.google && <Chip onClick={() => connect.startOAuth("google")}>Connect Google</Chip>}
        {features.slack && <Chip onClick={() => connect.startOAuth("slack")}>Connect Slack</Chip>}
        {features.whatsapp && <Chip onClick={() => connect.linkWhatsapp(setWhatsapp, refresh)}>Connect WhatsApp</Chip>}
      </Chips>
      {whatsapp && (
        <div>
          <Note>{whatsapp.status}</Note>
          {whatsapp.qrSrc && (
            // eslint-disable-next-line @next/next/no-img-element -- base64 data URI from WAHA
            <img src={whatsapp.qrSrc} alt="WhatsApp linking QR code" width={264} height={264} />
          )}
        </div>
      )}
      <div>
        <FieldLabel htmlFor="uploadDoc">Upload a document (.txt, .md, .csv)</FieldLabel>
        <input
          type="file"
          id="uploadDoc"
          accept=".txt,.md,.csv"
          className="text-sm"
          onChange={async (e) => {
            const input = e.target;
            const file = input.files?.[0];
            if (!file) return;
            try {
              await connect.uploadDocument(file);
              await refresh();
            } catch (err) {
              console.error("upload failed", err);
            } finally {
              input.value = "";
            }
          }}
        />
      </div>
    </FieldGroup>
  );
}
