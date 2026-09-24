import { describe, expect, it } from "vitest";
import {
  argsOf,
  isReadTool,
  parseAuthenticate,
  resultText,
  rpcMessages,
  searchCatalog,
  serviceListing,
  serviceSlugOf,
  serviceToolOf,
  serviceUrlOf,
  type CatalogService,
} from "@/lib/shared/mcp";

const entry = (name: string, domain: string, about = "", featured = false): CatalogService => ({
  slug: domain,
  name,
  domain,
  url: `https://mcp.${domain}/mcp`,
  auth: null,
  featured,
  about,
});

describe("searchCatalog", () => {
  const catalog = [
    entry("Notion", "notion.com", "Pages and databases.", true),
    entry("Linear", "linear.app", "Issues, projects and cycles.", true),
    entry("Todoist", "todoist.com", "Tasks and projects."),
    entry("Line Messaging", "line.me", "Chat bots."),
    entry("Café Órbita", "cafe.example", "Coffee orders."),
  ];

  it("returns the catalog's own order for an empty query", () => {
    expect(searchCatalog(catalog, "  ", 2).map((s) => s.name)).toEqual(["Notion", "Linear"]);
  });

  it("puts a name that starts with the query first, then name or domain matches, then descriptions", () => {
    expect(searchCatalog(catalog, "lin").map((s) => s.name)).toEqual(["Linear", "Line Messaging"]);
    expect(searchCatalog(catalog, "projects").map((s) => s.name)).toEqual(["Linear", "Todoist"]);
  });

  it("needs every word, ignoring case and accents", () => {
    expect(searchCatalog(catalog, "CAFE orbita").map((s) => s.name)).toEqual(["Café Órbita"]);
    expect(searchCatalog(catalog, "tasks issues")).toEqual([]);
  });
});

describe("serviceUrlOf", () => {
  it("takes an https address on a public hostname, without its fragment", () => {
    expect(serviceUrlOf("https://mcp.linear.app/mcp#x")?.toString()).toBe("https://mcp.linear.app/mcp");
    expect(serviceUrlOf(" https://ai.todoist.net/mcp?team=1 ")?.toString()).toBe("https://ai.todoist.net/mcp?team=1");
  });

  it("refuses http, credentials, IP literals and local names", () => {
    for (const bad of [
      "http://mcp.linear.app/mcp",
      "https://user:pw@mcp.linear.app/mcp",
      "https://127.0.0.1/mcp",
      "https://10.0.0.8/mcp",
      "https://[::1]/mcp",
      "https://localhost/mcp",
      "https://printer.local/mcp",
      "https://db.internal/mcp",
      "https://intranet/mcp",
      "ftp://mcp.example.com",
      "not a url",
      42,
    ]) {
      expect(serviceUrlOf(bad), String(bad)).toBeNull();
    }
  });
});

describe("parseAuthenticate", () => {
  it("reads a Bearer challenge's parameters", () => {
    expect(
      parseAuthenticate('Bearer realm="OAuth", resource_metadata="https://mcp.linear.app/.well-known/oauth-protected-resource/mcp", scope="read write"')
    ).toEqual({ realm: "OAuth", resource_metadata: "https://mcp.linear.app/.well-known/oauth-protected-resource/mcp", scope: "read write" });
    expect(parseAuthenticate('Bearer error=invalid_token, error_description="a \\"quoted\\" word"')).toEqual({
      error: "invalid_token",
      error_description: 'a "quoted" word',
    });
    expect(parseAuthenticate(null)).toEqual({});
  });
});

describe("rpcMessages", () => {
  it("reads a JSON body and a batch", () => {
    expect(rpcMessages('{"jsonrpc":"2.0","id":1,"result":{}}', "application/json")).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
    expect(rpcMessages('[{"id":1},{"id":2}]', "application/json; charset=utf-8")).toHaveLength(2);
    expect(rpcMessages("<html>", "text/html")).toEqual([]);
  });

  it("reads every event's data from an SSE stream, multi-line data joined, CRLF too", () => {
    const body = 'event: message\ndata: {"id":1,\ndata: "result":{"a":1}}\n\n: comment\r\nid: 7\r\ndata:{"id":2,"result":{}}\r\n\r\n';
    expect(rpcMessages(body, "text/event-stream")).toEqual([
      { id: 1, result: { a: 1 } },
      { id: 2, result: {} },
    ]);
  });
});

describe("isReadTool", () => {
  it("follows the server's annotations when it gives them", () => {
    expect(isReadTool({ name: "delete_issue", annotations: { readOnlyHint: true } })).toBe(true);
    expect(isReadTool({ name: "get_issue", annotations: { readOnlyHint: false } })).toBe(false);
    expect(isReadTool({ name: "list_issues", annotations: { destructiveHint: true } })).toBe(false);
  });

  it("without annotations, reads only when the name starts with a read verb and names no write", () => {
    for (const name of ["get_issue", "listProjects", "search", "read_wiki_contents", "ask_wiki_question", "fetch-page"]) expect(isReadTool({ name }), name).toBe(true);
    for (const name of ["create_issue", "get_or_create_label", "sendMessage", "issue_get", "list_and_archive", "run_query", ""]) expect(isReadTool({ name }), name).toBe(false);
  });
});

describe("serviceToolOf", () => {
  it("keeps the name, the description and a pruned schema, and says whether it reads", () => {
    const tool = serviceToolOf({
      name: "search_issues",
      title: "Search",
      description: "Search issues   by text.",
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", description: "Words to find.", examples: ["bug"] },
          state: { type: "string", enum: ["open", "closed"] },
          labels: { type: "array", items: { type: "string" } },
        },
        required: ["query"],
      },
      annotations: { readOnlyHint: true },
      _meta: { vendor: 1 },
    });
    expect(tool).toEqual({
      name: "search_issues",
      description: "Search issues by text.",
      read: true,
      schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Words to find." },
          state: { type: "string", enum: ["open", "closed"] },
          labels: { type: "array", items: { type: "string" } },
        },
        required: ["query"],
      },
    });
  });

  it("falls back to top-level types for a schema too big to keep", () => {
    const properties = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`p${i}`, { type: "string", description: "x".repeat(150) }]));
    const tool = serviceToolOf({ name: "big", inputSchema: { type: "object", properties, required: ["p1"] } });
    expect(tool!.schema).toEqual({ type: "object", properties: Object.fromEntries(Object.keys(properties).map((k) => [k, { type: "string" }])), required: ["p1"] });
  });

  it("drops a tool without a name", () => {
    expect(serviceToolOf({ description: "nameless" })).toBeNull();
    expect(serviceToolOf(null)).toBeNull();
  });
});

describe("argsOf", () => {
  it("spells a tool's arguments out on one line", () => {
    const schema = {
      type: "object",
      properties: {
        title: { type: "string", description: "The issue title." },
        priority: { type: "integer", enum: [0, 1, 2] },
        labels: { type: "array", items: { type: "string" } },
        assignee: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        due: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
      required: ["title"],
    };
    expect(argsOf(schema)).toBe('title*: string (The issue title.), priority: 0|1|2, labels: string[], assignee: {id*: string}, due: string|null');
    expect(argsOf(schema, false)).toBe('title*: string, priority: 0|1|2, labels: string[], assignee: {id*: string}, due: string|null');
  });
});

describe("serviceListing", () => {
  const tools = Array.from({ length: 40 }, (_, i) => ({
    name: `tool_${i}`,
    description: `Does thing ${i}. ${"More words. ".repeat(20)}`,
    schema: { type: "object", properties: { q: { type: "string", description: "What to look for, in detail." } }, required: ["q"] },
    read: i % 2 === 0,
  }));

  it("lists every tool with its arguments, marking actions", () => {
    const [s] = serviceListing([{ slug: "linear", name: "Linear", tools: tools.slice(0, 2) }]);
    expect(s.service).toBe("linear");
    expect(s.tools[0]).toMatchObject({ name: "tool_0", args: "q*: string (What to look for, in detail.)" });
    expect(s.tools[0].action).toBeUndefined();
    expect(s.tools[1].action).toBe(true);
  });

  it("stays within its budget, dropping notes, then shortening, then counting the tools left out", () => {
    const services = [
      { slug: "a", name: "A", tools },
      { slug: "b", name: "B", tools },
    ];
    const listing = serviceListing(services, 6000);
    expect(JSON.stringify(listing).length).toBeLessThanOrEqual(6000);
    expect(listing[0].tools[0].args).toBe("q*: string");
    expect(listing[0].more_tools).toBeGreaterThan(0);
    expect(listing[0].tools.length + listing[0].more_tools!).toBe(40);
  });
});

describe("resultText", () => {
  it("joins text parts, names the others, and clips", () => {
    const result = {
      content: [
        { type: "text", text: "First." },
        { type: "image", data: "…", mimeType: "image/png" },
        { type: "resource", resource: { uri: "file:///a", text: "Inline." } },
        { type: "resource_link", uri: "https://x.example/1", name: "Spec" },
      ],
    };
    expect(resultText(result)).toEqual({ text: "First.\n\n[image]\n\nInline.\n\n[link Spec https://x.example/1]", isError: false, clipped: false });
    expect(resultText({ content: [{ type: "text", text: "x".repeat(20) }], isError: true }, 10)).toEqual({ text: `${"x".repeat(10)}…`, isError: true, clipped: true });
  });

  it("uses structured content when there is no text", () => {
    expect(resultText({ content: [], structuredContent: { total: 3 } }).text).toBe('{"total":3}');
  });
});

describe("serviceSlugOf", () => {
  it("makes a short unique key", () => {
    expect(serviceSlugOf("Google Calendar (beta)")).toBe("google_calendar_beta");
    expect(serviceSlugOf("Linear", ["linear", "linear_2"])).toBe("linear_3");
    expect(serviceSlugOf("!!!")).toBe("service");
  });
});
