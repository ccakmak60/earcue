# 006 — Meta AI agent ("Muse") vs Grok bot (xAI): architecture + integrations

Research output for the Meta-vs-Grok comparison ticket. **Facts + a comparison.**
Every non-trivial claim is cited to a primary source (official Meta / xAI docs,
official newsroom / launch posts, first-party help pages) with access date, or
marked **UNVERIFIED**.

Read date: 2026-09-14. All prices USD unless noted.

---

## 0. Scope and naming note

1. **"Muse by Meta" now exists — as of September 2026.** Meta's newsroom
   introduced "Muse: The World's First Personal AI Agent Built for Everyone" on
   2026-09-08, and Meta's AI hub describes it as "Meet Muse, our new AI agent
   that takes tasks off your plate"
   (https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/;
   https://ai.meta.com/ — meta description). Before this launch the phrase
   "Muse by Meta" had no well-known referent, so this note treats **Meta Muse
   (personal agent) + Meta AI assistant + Muse model family** as the primary
   subject.
2. **Disambiguation.** "Muse" is Meta's agent brand
   (https://ai.meta.com/muse/ — "Meet Muse, Meta's personal AI agent").
   **Claude is a different product by a different company**: "Claude is
   Anthropic's AI" (https://claude.com/product/overview). Other "Muse"
   namesakes (e.g. GitHub's Copilot-adjacent "Muse" offerings, assorted
   third-party "Muse AI" tools) are unrelated to Meta — **UNVERIFIED** in
   detail, listed here only to warn against conflation; no secondary write-up
   is relied on for this.
3. **"Grok bot" covers two xAI things**: the Grok assistant (chatbot + API
   models) and the newer **Grok Bot** persistent-teammate product
   (https://x.ai/bot; https://docs.x.ai/grok-bot/overview). Both are covered.
4. **"Verified"** = I read the claim on a primary page today. Anything from a
   JS-rendered page I could not read, a failed fetch, or general knowledge is
   **UNVERIFIED**.

---

## 1. Meta side

### 1.1 What the products are

- **Muse (personal AI agent)** launched 2026-09-08: "a secure, private personal
   AI agent that proactively helps with people's goals and suggests ideas… It
   doesn't just answer questions, it actually does the work"
   (https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/).
   Rolling out in the US on iOS, Android, and muse.ai, "free for most of what
   people need, with subscription plans for people who want to do more"; AI
   glasses support "coming soon" (same source).
- **Meta AI assistant** is the conversational assistant inside the Meta AI app /
   website and across Facebook, Instagram, Messenger, WhatsApp
   (https://www.meta.com/help/artificial-intelligence/3898022273743835/ lists
   assistant help topics and notes it "can also be used on Facebook, Instagram,
   Messenger and WhatsApp"). Talking to Muse "works just like messaging another
   person, in the Muse app or directly in WhatsApp"
   (https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/).
- **Muse Spark** is the underlying model powering the agent: "powered by Muse
   Spark, Meta's most capable model to date, built for real-world agentic work"
   (same newsroom post). Muse Spark was first announced 2026-04-08 as "the
   first in a new series of large language models built by Meta
   Superintelligence Labs… small and fast by design, yet capable enough to
   reason through complex questions in science, math, and health", initially
   powering the Meta AI app and meta.ai with Instant/Thinking modes and
   parallel subagents
   (https://about.fb.com/news/2026/04/introducing-muse-spark-meta-superintelligence-labs/).
   Relationship of the Muse series to the older Llama open-weight line is not
   spelled out in the pages read — **UNVERIFIED** beyond "new series" language.

### 1.2 Model family (developer surface: Meta Model API)

All from first-party developer docs (https://ai.developer.meta.com/docs/
overview page):

- **Four families**: "Muse Spark, Muse Image, and Muse Voice Transcribe are
   hosted on Meta Model API… Muse Glimmer is open-weight and runs on your own
   hardware" (https://ai.developer.meta.com/docs/ overview).
- **Muse Spark** (`muse-spark-1.3` / 1.2 / 1.1): "model for agentic and coding
   work — multi-step tool loops, software engineering assistants, and
   long-context reasoning"; 1,048,576-token context; input text/image/video/
   audio/PDF, output text; 1.3 "tuned for agentic workflows (multi-step tool,
   browser, and long-horizon tasks) with improved coding over 1.2"
   (https://ai.developer.meta.com/docs/models).
- **Muse Image** (`muse-image-1.0`): text/image in, image out; "can search the
   web for visual references and current facts and run code to build layouts
   before it renders" (https://ai.developer.meta.com/docs/models).
- **Muse Voice Transcribe** (`muse-voice-transcribe-1.0`): speech-to-text only
   — "does not synthesize speech or provide a speech-to-speech conversation
   API", no word-level timestamps; realtime WebSocket + file endpoints
   (https://ai.developer.meta.com/docs/models).
- **Muse Glimmer**: 30B-parameter "dense, decoder-only multimodal transformer
   with a built-in vision encoder… trained from Muse Spark's outputs",
   text+image in / text out, 128K default context, weights under **Apache
   2.0**, runnable via vLLM/SGLang/llama.cpp/ExecuTorch
   (https://ai.developer.meta.com/docs/muse-glimmer).
- **Base URL + auth**: `https://api.meta.ai/v1`, `Authorization: Bearer
   $MODEL_API_KEY` (https://ai.developer.meta.com/docs/api-reference).
- **Three wire formats, same models/pricing**: Responses (`POST
   /v1/responses`, recommended for agents), Chat Completions
   (`/v1/chat/completions`, OpenAI messages-array drop-in), Messages
   (`/v1/messages`, Anthropic-compatible for Claude-oriented tools)
   (https://ai.developer.meta.com/docs/protocols).
- **Pricing** (https://ai.developer.meta.com/docs/pricing-rate-limits):
   Standard tier (`muse-spark-1.x`): $1.25 / $4.25 per 1M input / output
   tokens, $0.15 cached input; Contributor tier (`-contributor` variants,
   trains on your prompts/completions): $0.10 / $0.20, $0.002 cached;
   web-search grounding $2.50 per 1,000 search queries; Muse Image flat $0.01
   per image; Voice Transcribe $0.18/hour; no long-context premium.

### 1.3 Agent/tool-use architecture (as disclosed)

- **Reasoning model with dialable effort**: `reasoning_effort`
   none/minimal/low/medium/high/xhigh/max; Muse Spark does not support "none";
   "max" is Standard-tier 1.3 only; Responses API carries reasoning across
   turns via `previous_response_id` or encrypted replay, Chat Completions does
   not for external keys (https://ai.developer.meta.com/docs/reasoning).
- **Developer-defined tools**: `function` (JSON Schema params) and `custom`
   (freeform text, Responses-only) tools; model returns `function_call` items,
   the app executes locally and returns `function_call_output`; parallel calls
   and streamed args supported; built-in tools `web_search` and `tool_search`
   can be mixed in (https://ai.developer.meta.com/docs/tool-calling).
- **Tool search / namespaces**: `{"type": "tool_search"}` + `defer_loading`
   keeps parameter schemas out of the prompt until needed; namespace tool
   groups functions under a dot-free prefix (function names allow at most one
   dot); hosted (API-side) or client-executed modes; Responses-only
   (https://ai.developer.meta.com/docs/tool-search).
- **Search grounding**: add `{"type": "web_search"}` on Responses; server-side
   search returns `web_search_call` + `url_citation` annotations (+opt-in raw
   `results`); `search_context_size` trades depth for latency/tokens
   (https://ai.developer.meta.com/docs/search-grounding).
- **Computer tool**: `{"type": "computer"}` on Responses; observe-act loop over
   screenshots → structured actions (click/double_click/drag/keypress/move/
   scroll/type/screenshot/wait) executed by the developer's own driver
   (Playwright/Puppeteer/pyautogui); per-action `pending_safety_checks` must be
   acknowledged; no Meta-hosted VM on this path — "Meta doesn't run a browser
   or desktop for you" (https://ai.developer.meta.com/docs/computer-use).
- **Structured output, files, caching**: documented capabilities include
   structured output, file handling by ID, prompt caching, token counting
   (docs overview nav; details not re-verified this pass — claims beyond names
   **UNVERIFIED**).
- **Framework interop**: first-party guides for driving Muse Spark from the
   Claude Agent SDK (via Messages API) and the OpenAI Codex app-server (via
   Responses API), plus OpenCode/Codex/Claude Code configs
   (https://ai.developer.meta.com/docs/agent-frameworks,
   https://ai.developer.meta.com/docs/coding-agents).

### 1.4 Muse agent runtime (consumer agent: Secure VM + Sentinel)

From the launch post and the research-blog safety deep-dive:

- **Own cloud computer**: "Muse runs on Muse Secure VM, a dedicated, virtual
   machine (VM) that houses both the agent and a person's data", with its own
   browser; keeps working after the app closes and returns for approvals
   (https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/).
- **Isolation design**: harness ("hatch" daemon), workspace, and tool binaries
   run in a `systemd-nspawn` runtime cell (unprivileged uid map, own rootfs,
   filtered syscalls, limited caps, virtual NIC); safety/credential/network
   services live outside the cell as separate systemd units communicating over
   Unix sockets with SO_PEERCRED ACLs
   (https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse).
- **Sentinel gatekeeper**: "a separate host-side agent… the sole permission
   authority for approval to perform actions with connectors… and for all
   egress"; untrusted-data taint tracking (eBPF) decides when to auto-allow vs
   ask; credential surrogation means "the agent never sees real tokens"
   (same source).
- **Least privilege + browser**: built-in connectors execute outside the cell
   via `privsep` workers with per-credential allowlists; browser driven via an
   outside-cell CDP broker on accessibility-tree snapshots (no page JS for the
   agent); email connector filters OTP/password-reset/magic links; checkout
   pages trigger human approval (same source).
- **Memory + control**: Muse "remembers what matters… they can always tell it
   to 'forget'"; per-app scoped access, revocable; opt-out of training use;
   "doesn't share conversations or VM data with ad systems"; full audit trail;
   bug bounty up to $300,000 (launch post + safety post). A future "Muse
   Confidential VM" would encrypt the VM with a user-held key — **not yet
   launched** (same sources).
- **Payments/credentials**: checkout via Link by Stripe one-time-use cards
   ("first AI agent covered by Link's purchase protections"); Shop Pay and
   1Password support "coming soon" (launch post). Credential capture UI routes
   secrets straight to `authd`, invisible to the agent (safety post).
- **Model hardening**: trained for "zero-shot tool calling using CLIs and
   skills, long context, long-trajectory instruction following with inherent
   awareness of prompt injection, and multi-agent coordination", plus external
   prompt-injection classifier ensemble and red-teaming (safety post).

### 1.5 Integration surfaces

- **Consumer**: Muse app (iOS/Android), muse.ai web, WhatsApp chat; Meta AI
   assistant across FB/IG/Messenger/WhatsApp and Ray-Ban/Oakley glasses
   rollout (launch post; Spark post May-12 update; help center).
- **Third-party connections**: Accounts Center → connect calendars, email,
   etc.; "Meta AI can then use information from your third party app to
   personalize responses"; examples: flight lookup, calendar adds, email
   summaries (https://www.meta.com/help/artificial-intelligence/1066348732357744/).
   Instagram saved reels → grocery lists and Marketplace shopping mode are
   first-party ecosystem integrations (launch + Spark posts).
- **Developer**: Meta Model API (OpenAI/Anthropic-compatible), Muse Code CLI
   (`curl -fsSL https://dev.meta.ai/install.sh | sh`; interactive + `muse exec`
   headless; approvals + sandbox on by default;
   https://ai.developer.meta.com/docs/muse-code), MCP servers via
   `mcp_servers` settings (stdio / streamable_http; "MCP tools are not
   sandboxed" — https://ai.developer.meta.com/docs/muse-code/extending),
   skills/hooks/subagents/workflows/session messaging (same source).

---

## 2. Grok side (xAI, now styled "SpaceXAI")

### 2.1 What the products are

- xAI's homepage now brands the company **SpaceXAI** — "SpaceXAI builds Grok"
   (https://x.ai/ meta + hero). The assistant is **Grok**: "an AI assistant
   built by SpaceXAI. Chat, create images, write code, and get real-time
   answers from the web and X" (https://grok.com/ meta description).
- Current flagship model is **Grok 4.6** ("our new model", "most intelligent
   and fastest model we've built"; knowledge cutoff 2026-02-01), alongside
   4.5/4.3, `grok-build-0.1` coding model (early access), Imagine image/video
   models, and voice models (https://docs.x.ai/docs/overview,
   https://docs.x.ai/docs/models).
- **Grok Bot** (launched 2026-08-11) is the persistent-agent product: "AI
   teammates you can give real work to… have their own computer… keep working
   24/7" (https://x.ai/news/introducing-grok-bot); beta for SuperGrok(+/Heavy)
   and Cursor Pro/Pro+/Ultra/Teams, with enterprise controls added 2026-09-03
   (https://x.ai/news/grok-bot-for-enterprise).

### 2.2 Models + architecture disclosures

- **Context/pricing** (https://docs.x.ai/docs/models): Grok 4.6 — 500K
   context, $2.00/$6.00 per 1M input/output (<200K prompt), doubling past
   200K; cached input $0.50. 4.3/4.20 — 1M context, $1.25/$2.50. Imagine image
   from $0.02/image, video from $0.05/s. Voice: speech-to-speech $0.08/min,
   TTS $15/1M chars.
- **No training-architecture disclosure found** in the docs read (no model
   card / system card / parameter count encountered on docs.x.ai) —
   architecture internals **UNVERIFIED**. What the docs do state: "Grok has no
   knowledge of current events or data beyond… training data. To incorporate
   realtime data… enable server-side search tools (Web Search / X Search)"
   (https://docs.x.ai/docs/models); chat models allow free role ordering;
   `logprobs` silently ignored on 4.20+ (same source).
- **Modalities**: "One API. Every modality. Text, code, voice, images, and
   video — all through a single unified API" (https://x.ai/); image input
   (≤20MB, jpg/png, unlimited count) documented
   (https://docs.x.ai/docs/models).

### 2.3 Agent/tool-use architecture (as disclosed)

- **Function calling**: define `type: function` tools (name/description/JSON
   Schema), model returns `tool_call`/`function_call`, developer executes
   locally and returns output; Pydantic-schema authoring supported; streaming
   returns the call whole in one chunk
   (https://docs.x.ai/docs/tools/function-calling).
- **Web Search tool**: server-side browse with `allowed_domains` /
   `excluded_domains` (≤5), `enable_image_understanding` (adds `view_image`
   tool), `enable_image_search` (Markdown embeds); SDK names `web_search` /
   `xai.tools.webSearch()` (https://docs.x.ai/docs/tools/web-search).
- **X Search tool** (Grok-exclusive): keyword/semantic/user search + thread
   fetch over X with `allowed/excluded_x_handles` (≤20), `from_date/to_date`,
   image/video understanding flags; re-billed from 2026-09-21 as $5/1K posts
   + $10/1K profiles fetched (https://docs.x.ai/docs/tools/x-search).
- **Structured outputs**: `response_format` json_schema/json_object/text with
   guaranteed schema conformance on supported keywords; tool args implicitly
   strict (https://docs.x.ai/docs/model-capabilities/text/structured-outputs —
   read succeeded via redirect path).
- **Reasoning/thinking modes**: docs reference "reasoning model" usage and
   "DeepSearch/Think"-style UX on the consumer side, but no developer
   `reasoning_effort`-style knob was found in the pages read — **UNVERIFIED**.
- **MCP support**: no first-party MCP doc page found (`/docs/tools/mcp`,
   `/docs/mcp`, `/developers/mcp` all 404 on 2026-09-14) — **UNVERIFIED**
   whether xAI offers a native MCP surface; community paths (Vercel AI SDK,
   LiteLLM) exist (https://docs.x.ai/docs/community).

### 2.4 Grok Bot runtime (persistent teammates)

- **Each Bot has a (shared) computer**: "AI teammates with names, jobs, and
   context that compounds… Each Bot works on a persistent cloud computer with
   a browser, filesystem, and terminal" — while "all of your Bots use the same
   cloud computer, sharing its files, browser sessions, and app logins"
   (per-user isolation between users)
   (https://docs.x.ai/grok-bot/overview). Messaging-driven setup ("a message,
   not a workflow builder"), bot-to-bot coordination + group chats, skills/
   routines learned from demonstration, compounding memory/files/sessions
   (same source; launch post adds CRM/inbox/deck/ops examples).
- **Platforms**: desktop app on macOS/Windows/Linux, mobile on iOS/Android;
   "computers Bots work on run in Cursor's cloud"; access bundled with paid
   Cursor plans or SuperGrok link, own usage meter separate from Grok/Cursor
   plans (https://docs.x.ai/grok-bot/overview,
   https://x.ai/news/introducing-grok-bot).
- **Enterprise** (2026-09-03): org-wide invites, access/network/audit
   controls; named customers Legora, Supermicro, ServiceTitan; sales/
   recruiting/marketing/finance/engineering use cases
   (https://x.ai/news/grok-bot-for-enterprise).

### 2.5 Integration surfaces

- **Consumer**: grok.com web app, Grok mobile/desktop apps, X platform
   presence (first-party X help page fetch failed on 2026-09-14 — in-X
   surfaces **UNVERIFIED** in detail), Grok Bot apps.
- **Developer**: `https://api.x.ai/v1` (OpenAI-compatible: Chat Completions +
   Responses), `xai_sdk` (Python/JS), Vercel AI SDK provider, LiteLLM proxy
   (https://docs.x.ai/docs/overview, https://docs.x.ai/docs/community);
   Code API / Grok Build for agentic coding (early access); Imagine + Voice
   APIs per modality.

---

## 3. Head-to-head comparison

| Dimension | Meta (Muse / Meta AI / Muse models) | Grok (assistant / Grok Bot / xAI API) |
|---|---|---|
| Flagship model (2026-09) | Muse Spark 1.3, 1M tokens; Image 1.0; Voice Transcribe 1.0; Glimmer 30B open weights (Apache 2.0) | Grok 4.6, 500K tokens (cutoff 2026-02-01); 4.3/4.20 1M; build-0.1 code; Imagine image/video; voice |
| Model openness | One fully open family (Glimmer, Apache 2.0, self-hosted); hosted Spark/Image/Voice closed, API-only | No open-weights offer found in docs read — **UNVERIFIED**; API-only posture in all pages read |
| Agent70904 loop primitives | Responses API w/ reasoning replay, parallel + streamed tool calls, custom tools, namespaces + deferred tool search, files, background execution | Responses/Chat APIs w/ function calling (implicit strict args), structured outputs, Pydantic/Zod authoring |
| Built-in live-data tools | `web_search` w/ citations + context-size knob ($2.50/1K queries); Image self-grounding included in $0.01/image | `web_search` (domain filters, image understand/search) + **`x_search` over X** (handles/date filters; per-post billing from 2026-09-21) |
| Computer use | `computer` tool = action **protocol** only; developer supplies driver/sandbox; consumer Muse adds full Secure VM + Sentinel + browser broker | Grok Bot = **hosted** persistent cloud computer (browser/files/terminal) per account; API devs get no disclosed computer-use primitive — **UNVERIFIED** |
| Safety architecture | Published: Secure VM (nspawn cell), Sentinel egress gate, authd surrogation, privsep connectors, taint tracking, classifiers, audit trail, $300K bounty, training opt-out, Confidential VM planned | No equivalent public safety-architecture doc found in pages read — **UNVERIFIED** |
| Persistent agent product | **Muse**: 1 user ↔ 1 dedicated VM, proactive suggestions, memory w/ forget, Link/Stripe one-time cards, US rollout, free + subscription | **Grok Bot**: N bots ↔ 1 shared computer per account, routines from demo, bot-to-bot handoff, Cursor-cloud hosted, plan-bundled meter |
| Consumer distribution | Muse app + muse.ai + WhatsApp; Meta AI in FB/IG/Messenger/WA/Threads + glasses; social-graph grounding (Reels/Marketplace) | grok.com + apps + X feed integration (details **UNVERIFIED**); real-time web + X corpus as differentiator |
| Developer extensibility | OpenAI + Anthropic wire compat; Muse Code CLI; MCP (client-side, unsandboxed); skills/hooks/subagents; Claude/Codex/OpenCode guides | OpenAI wire compat; xAI SDK; Vercel/LiteLLM community; Grok Build coding API; native MCP **UNVERIFIED** |
| Data moat | Meta ecosystem: social graph, Reels/Marketplace content, IG/FB connectors, on-device glasses | X corpus: full-fidelity posts/threads/users via `x_search`; web browse; Colossus-scale training infra claimed ("world's largest supercluster" — https://x.ai/, marketing, treat as vendor claim) |
| Price posture (text) | Standard $1.25/$4.25; Contributor $0.10/$0.20 (trains on data); no long-context premium | 4.6 $2.00/$6.00 (<200K), 2× past 200K; 4.3 $1.25/$2.50; cached $0.20–$0.50 |

---

## 4. Takeaways

1. **Different agent philosophies.** Meta published a full trust architecture
   (isolated VM + Sentinel + credential surrogation) for one personal agent per
   user; xAI ships a team of named bots sharing one account computer with
   demonstration-learned routines. Meta leads on disclosed safety engineering;
   Grok Bot leads on multi-bot orchestration UX.
2. **Different live-data moats.** Meta grounds in web search + its social
   ecosystem (Reels, Marketplace, IG/FB connectors, glasses); xAI's unique
   asset is first-party X firehose access via `x_search`.
3. **Developer parity on basics, divergence at the edges.** Both offer
   OpenAI-compatible function calling + server-side search + structured
   outputs. Meta alone documents deferred tool search/namespaces, tri-protocol
   (incl. Anthropic Messages) support, MCP client config, and an Apache-2.0
   local model; xAI alone documents X-native search and per-post billing.
4. **Openness edge: Meta.** Muse Glimmer (30B, Apache 2.0, vLLM/SGLang/
   llama.cpp/ExecuTorch) is verifiably downloadable; no xAI open-weights
   counterpart was found in primary docs.
5. **Caveats.** Llama-lineage of Muse Spark, xAI model internals, Grok
   reasoning knobs, xAI MCP support, and in-X Grok UX details are
   **UNVERIFIED** — each needs a primary source before being relied on.

---

## Sources (all accessed 2026-09-14)

- https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/ — Muse launch
- https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse — Muse safety architecture
- https://about.fb.com/news/2026/04/introducing-muse-spark-meta-superintelligence-labs/ — Muse Spark launch + Meta AI upgrade
- https://ai.meta.com/ — "Meet Muse" positioning (meta description)
- https://ai.meta.com/muse/ — Muse product page (meta description)
- https://muse.ai/ — Muse app landing (meta description)
- https://ai.developer.meta.com/docs/ — Model API overview (Muse families)
- https://ai.developer.meta.com/docs/models — family specs, context windows
- https://ai.developer.meta.com/docs/protocols — Responses/Chat/Messages choice
- https://ai.developer.meta.com/docs/api-reference — base URL + auth
- https://ai.developer.meta.com/docs/reasoning — reasoning_effort + replay
- https://ai.developer.meta.com/docs/tool-calling — function/custom tools
- https://ai.developer.meta.com/docs/tool-search — deferred tools/namespaces
- https://ai.developer.meta.com/docs/search-grounding — web_search + citations
- https://ai.developer.meta.com/docs/computer-use — computer tool protocol
- https://ai.developer.meta.com/docs/muse-code — Muse Code agent CLI
- https://ai.developer.meta.com/docs/muse-code/extending — MCP, skills, hooks, subagents
- https://ai.developer.meta.com/docs/agent-frameworks — Claude/Codex harness guides
- https://ai.developer.meta.com/docs/coding-agents — OpenCode/Codex/Claude Code setup
- https://ai.developer.meta.com/docs/pricing-rate-limits — tiers + rates
- https://ai.developer.meta.com/docs/muse-glimmer — 30B Apache-2.0 model
- https://www.meta.com/help/artificial-intelligence/3898022273743835/ — Meta AI help hub (FB/IG/Messenger/WA surfaces)
- https://www.meta.com/help/artificial-intelligence/1066348732357744/ — third-party app connections
- https://claude.com/product/overview — Claude is Anthropic's (disambiguation)
- https://x.ai/ — SpaceXAI/Grok positioning, unified API, model lineup
- https://x.ai/bot — Grok Bot product page
- https://x.ai/news/introducing-grok-bot — Grok Bot launch (2026-08-11)
- https://x.ai/news/grok-bot-for-enterprise — enterprise controls (2026-09-03)
- https://grok.com/ — Grok assistant positioning (meta description)
- https://docs.x.ai/docs/overview — API surface, Grok 4.6, Build/Imagine/Voice
- https://docs.x.ai/docs/models — pricing, context, cutoff, realtime-data note
- https://docs.x.ai/docs/tools/function-calling — function calling
- https://docs.x.ai/docs/tools/web-search — Web Search tool
- https://docs.x.ai/docs/tools/x-search — X Search tool + Sep-2026 billing
- https://docs.x.ai/docs/model-capabilities/text/structured-outputs — structured outputs
- https://docs.x.ai/docs/community — LiteLLM + Vercel integrations
- https://docs.x.ai/grok-bot/overview — Grok Bot docs (shared computer, skills, platforms)
- Failed/unreadable (recorded as UNVERIFIED, not cited as fact): https://www.meta.ai/,
  https://help.x.com/en/using-x/grok, https://faq.whatsapp.com/2257017191175152 (title only),
  xAI `/docs/tools/mcp`, `/docs/mcp`, `/developers/mcp` (404s).
