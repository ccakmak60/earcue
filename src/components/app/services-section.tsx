"use client";

import { useEffect, useMemo, useState } from "react";
import { PlugIcon, SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import * as svc from "@/lib/client/services";
import { searchCatalog, serviceUrlOf, type CatalogService } from "@/lib/shared/mcp";
import { ConfirmButton, Empty, IconTile, Kicker, Note, StatusLine } from "./primitives";
import type { ConnectionState } from "./settings-connections";

// "Connect a service" in the Sources view: the hosted MCP servers from the integrations.sh
// directory, searchable, plus any server by URL. Connecting one lets Ask earcue look things up in
// it (and, where the person allows it, act in it) while they chat; nothing it returns is stored.

const RESULTS = 6;

const AUTH_LABEL: Record<string, string> = { oauth: "Sign in", none: "No sign-in", api_key: "API key" };

const FAILED: Record<string, string> = {
  bad_key: "That key didn't work. Check it and try again.",
  not_mcp: "That address didn't answer like an MCP server.",
  unreachable: "Couldn't reach it. Try again in a moment.",
};

type Target = { url: string; name?: string; catalogSlug?: string };

function KeyForm({ target, busy, onSubmit }: { target: Target; busy: boolean; onSubmit: (apiKey: string, header: string) => void }) {
  const [key, setKey] = useState("");
  const [header, setHeader] = useState("");
  const id = `key-${target.url}`;
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (key.trim()) onSubmit(key.trim(), header.trim());
      }}
    >
      <div className="flex flex-wrap gap-2">
        <Input
          id={id}
          type="password"
          autoComplete="off"
          aria-label={`API key for ${target.name ?? target.url}`}
          placeholder="Paste an API key"
          className="min-w-0 flex-1 bg-card"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        <Input
          aria-label="Header the key goes in (optional)"
          placeholder="Header (Authorization)"
          className="w-44 bg-card max-[720px]:flex-1"
          maxLength={64}
          value={header}
          onChange={(e) => setHeader(e.target.value)}
        />
        <Button type="submit" size="sm" className="h-9" disabled={busy || !key.trim()}>
          Connect
        </Button>
      </div>
      <Note>Stored encrypted. Without a header name it&apos;s sent as a Bearer token.</Note>
    </form>
  );
}

function ServiceRow({ service, onChanged }: { service: svc.Service; onChanged: (next: svc.Service | null) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const actionTools = service.tools - service.readTools;
  const status =
    service.status === "needs_auth"
      ? "Signed out. Reconnect to use it again."
      : service.tools === 0
        ? service.lastError
          ? "Connected, but its tools couldn't be listed yet."
          : "Connected. It lists no tools."
        : `${service.tools} tools · ${service.readTools} look things up${actionTools > 0 ? ` · ${actionTools} take actions` : ""}`;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (err) {
      console.error("service action failed", err);
      setError("That didn't go through. Try again in a moment.");
    }
    setBusy(false);
  }

  return (
    <li className="flex flex-col gap-2 p-3">
      <div className="flex items-center gap-3">
        <IconTile icon={PlugIcon} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{service.name}</div>
          <div className={service.status === "needs_auth" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{status}</div>
        </div>
        <ConfirmButton
          label="Disconnect"
          title={`Disconnect ${service.name}?`}
          description="earcue forgets its sign-in and stops calling it. Nothing it returned was stored, so there is nothing else to delete."
          confirmLabel="Disconnect"
          onConfirm={async () => {
            await svc.disconnectService(service.id);
            onChanged(null);
          }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pl-12">
        {actionTools > 0 && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="size-4 accent-foreground"
              checked={service.allowActions}
              disabled={busy}
              onChange={(e) => run(async () => onChanged(await svc.setAllowActions(service.id, e.target.checked)))}
            />
            Let earcue take actions here when you ask
          </label>
        )}
        {service.status === "needs_auth" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              run(async () => {
                const outcome = await svc.connectService({ url: service.url, name: service.name });
                if ("authorize" in outcome) location.href = outcome.authorize;
                else if ("connected" in outcome) onChanged(outcome.connected);
                else setError("needs" in outcome ? "It needs an API key now. Disconnect it and connect again with one." : FAILED[outcome.failed]);
              })
            }
          >
            Reconnect
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              run(async () => {
                const res = await svc.refreshService(service.id);
                onChanged(res.service);
                if (res.failed) setError(res.failed === "signed_out" ? "It no longer accepts earcue's sign-in." : FAILED[res.failed] || "Couldn't list its tools.");
              })
            }
          >
            Refresh tools
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="pl-12 text-xs text-destructive">
          {error}
        </p>
      )}
    </li>
  );
}

export function ServicesSection({ connections: c }: { connections: ConnectionState }) {
  const [catalog, setCatalog] = useState<CatalogService[] | null>(null);
  const [catalogFailed, setCatalogFailed] = useState(false);
  const [q, setQ] = useState("");
  const [customUrl, setCustomUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  // The server that asked for a key, and why.
  const [keyFor, setKeyFor] = useState<Target | null>(null);
  const services = c.services;
  const available = Boolean(c.features.services);

  useEffect(() => {
    if (!available || catalog) return;
    svc.loadCatalog().then(setCatalog, (err) => {
      console.error("service catalog failed", err);
      setCatalogFailed(true);
    });
  }, [available, catalog]);

  const connectedUrls = useMemo(() => new Set((services ?? []).map((s) => s.url)), [services]);
  const results = useMemo(() => (catalog ? searchCatalog(catalog, q, RESULTS) : []), [catalog, q]);

  if (!available) return null;

  function changed(id: string, next: svc.Service | null) {
    c.setServices((list) => (next ? (list ?? []).map((s) => (s.id === id ? next : s)) : (list ?? []).filter((s) => s.id !== id)));
  }

  async function connect(target: Target, key?: { apiKey: string; header: string }) {
    setBusy(target.url);
    setError("");
    setStatus(`Connecting ${target.name ?? new URL(target.url).hostname}…`);
    try {
      const outcome = await svc.connectService({ ...target, ...(key ? { apiKey: key.apiKey, ...(key.header ? { header: key.header } : {}) } : {}) });
      if ("authorize" in outcome) {
        setStatus(`Opening ${target.name ?? "the service"}'s sign-in…`);
        location.href = outcome.authorize;
        return;
      }
      setStatus("");
      if ("connected" in outcome) {
        setKeyFor(null);
        c.setServices((list) => [...(list ?? []).filter((s) => s.id !== outcome.connected.id), outcome.connected]);
        setStatus(`${outcome.connected.name} is connected. Ask earcue about it in Memory.`);
      } else if ("needs" in outcome) {
        setKeyFor(target);
      } else {
        if (outcome.failed !== "bad_key") setKeyFor(null);
        setError(FAILED[outcome.failed]);
      }
    } catch (err) {
      console.error("service connect failed", err);
      setStatus("");
      setError(String((err as Error).message).endsWith(" 400") ? "That address or key isn't one earcue can use." : "That didn't go through. Try again in a moment.");
    }
    setBusy(null);
  }

  const customValid = Boolean(serviceUrlOf(customUrl));

  return (
    <section aria-labelledby="servicesHeading" className="flex flex-col gap-3">
      <Kicker as="h2" className="mb-0">
        <span id="servicesHeading">Connect a service</span>
      </Kicker>
      <p className="max-w-[34rem] text-sm leading-relaxed text-muted-foreground">
        Tasks, issues, documents and more, from{" "}
        {catalog ? `${Math.floor(catalog.length / 100) * 100}+` : "hundreds of"} services with an MCP server. Ask earcue looks things up in them while you chat. What they
        return isn&apos;t stored.
      </p>

      {services && services.length > 0 && (
        <ul className="divide-y rounded-lg border bg-card" aria-label="Connected services">
          {services.map((s) => (
            <ServiceRow key={s.id} service={s} onChanged={(next) => changed(s.id, next)} />
          ))}
        </ul>
      )}

      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          type="search"
          aria-label="Search services"
          placeholder={catalog ? `Search ${catalog.length.toLocaleString()} services: Linear, Notion, Todoist…` : "Search services"}
          className="bg-card pl-9"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {catalogFailed && <Empty>The directory didn&apos;t load. You can still connect a server by its URL below.</Empty>}
      {catalog && results.length === 0 && <Empty>No service matches “{q}”. Try its company name, or connect it by URL below.</Empty>}
      {results.length > 0 && (
        <ul className="divide-y rounded-lg border bg-card" aria-label="Services">
          {results.map((s) => {
            const connected = connectedUrls.has(s.url);
            const target = { url: s.url, name: s.name, catalogSlug: s.slug };
            return (
              <li key={s.url} className="flex flex-col gap-3 p-3">
                <div className="flex items-center gap-3">
                  <IconTile icon={PlugIcon} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{s.name}</div>
                    <div className="truncate text-xs text-muted-foreground" title={s.about}>
                      {s.domain}
                      {s.auth ? ` · ${AUTH_LABEL[s.auth]}` : ""}
                      {s.about ? ` · ${s.about}` : ""}
                    </div>
                  </div>
                  <Button size="sm" variant="outline" disabled={connected || busy !== null} onClick={() => connect(target)}>
                    {connected ? "Connected" : "Connect"}
                  </Button>
                </div>
                {keyFor?.url === s.url && <KeyForm target={keyFor} busy={busy !== null} onSubmit={(apiKey, header) => connect(keyFor, { apiKey, header })} />}
              </li>
            );
          })}
        </ul>
      )}

      <details className="group text-sm">
        <summary className="cursor-pointer list-none text-muted-foreground underline-offset-4 hover:text-foreground hover:underline [&::-webkit-details-marker]:hidden">
          Connect a server by URL
        </summary>
        <form
          className="mt-2 flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (customValid) connect({ url: customUrl.trim() });
          }}
        >
          <Input
            type="url"
            aria-label="MCP server URL"
            placeholder="https://mcp.example.com/mcp"
            className="min-w-0 flex-1 bg-card"
            value={customUrl}
            onChange={(e) => setCustomUrl(e.target.value)}
          />
          <Button type="submit" size="sm" className="h-9" disabled={!customValid || busy !== null}>
            Connect
          </Button>
        </form>
        {keyFor && !results.some((s) => s.url === keyFor.url) && (
          <div className="mt-3">
            <KeyForm target={keyFor} busy={busy !== null} onSubmit={(apiKey, header) => connect(keyFor, { apiKey, header })} />
          </div>
        )}
      </details>

      {keyFor && !error && <p className="text-sm">{keyFor.name ?? "This server"} needs an API key from its settings to connect.</p>}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {status && <StatusLine busy={busy !== null}>{status}</StatusLine>}
      <Note>
        Directory from{" "}
        <a href="https://integrations.sh" target="_blank" rel="noopener noreferrer" className="underline">
          integrations.sh
        </a>
        . Services run by others: earcue sends them what Ask earcue looks up there, and actions stay off until you turn them on.
      </Note>
    </section>
  );
}
