# earcue design system

Agent-facing source of truth for any UI work in this repo. Follow it instead of improvising.

## Sources and precedence

1. This file is the authority for product UI. It adapts `https://vercel.com/design.md` (Vercel restraint, composition, typography, evidence rules) to earcue's existing warm light theme and shadcn/Tailwind v4 stack.
2. earcue tokens in `src/app/globals.css` are the only color, type, radius, shadow, and container values. NEVER invent a parallel palette, import `vercel-brand.css`, or add `vbg-*` classes. This repo is an existing product project: use installed Geist plus `--ec-*` tokens, per the Vercel skill's own integration rule.
3. Motion follows Vercel stillness first, then the exact values in the Motion section below (Emil + better-ui, pinned — not ranges to approximate).
4. Existing patterns in `src/components/app/primitives.tsx`, `src/components/marketing/mock.tsx`, and `src/components/ui/*` win over any new idea. Reuse them; second conventions beside existing ones are prohibited.

## Principles

- Precise, calm, direct, restrained. One continuous canvas; earn every surface.
- Hierarchy through typography and spacing before borders, boxes, or color.
- Monochrome first. Color only with meaning plus a non-color cue (label, icon, text).
- One dominant object per viewport or section. Every section answers a new reader question; combine duplicates, remove ceremony.
- Squint test: dominant claim and reading path obvious with words blurred. Text-mask test: hierarchy still reads via scale, spacing, and grouping.
- Beauty is leverage, but unseen correctness compounds: optical alignment, concentric radii, named transitions, press feedback.

## Tokens (exact, from `src/app/globals.css`)

Single light theme. There is no `.dark` block; ignore `dark:` variants left in shadcn defaults.

| Role | Token | Value |
|---|---|---|
| paper / background | `--ec-paper` / `--background` | `#fbfaf7` |
| surface / card / popover | `--ec-surface` / `--card` | `#ffffff` |
| sunken / secondary / muted | `--ec-surface-sunken` | `#f4f2ec` |
| hover / accent bg | `--ec-surface-hover` / `--accent` | `#f1eee7` |
| accent soft | `--ec-accent-soft` (`bg-brand-soft`) | `#fcefe4` |
| ink / foreground / contrast | `--ec-ink` / `--foreground` | `#1b1a17` |
| ink secondary | `--ec-ink-secondary` | `#6b675e` |
| ink tertiary | `--ec-ink-tertiary` (`text-ink-tertiary`) | `#98938a` |
| line / border | `--ec-line` / `--border` | `#e9e5db` |
| line strong / input | `--ec-line-strong` / `--input` | `#d8d3c5` |
| brand accent | `--ec-accent` (`bg-brand`, `text-brand`) | `#c2560f` |
| focus ring | `--ec-focus` / `--ring` | `#c2560f` |
| danger / destructive | `--ec-danger` / `--destructive` | `#b42318` |
| on-contrast text | `--ec-on-contrast` | `#fbfaf7` |

Radius: `--ec-radius: 12px`, `--ec-radius-sm: 8px`. Tailwind maps `radius-sm/md/lg/xl` from these; prefer `rounded-sm` (small controls, toasts, chips), `rounded-lg` (cards, mocks). Concentric rule: outer radius = inner radius + padding; fix mismatched nested radii instead of adding borders.

Shadows: `--ec-shadow-sm` (nav active, onboard), `--ec-shadow-md` (mocks, dropdowns), `--ec-shadow-lg` (hero mock only). Borders communicate structure; shadows communicate elevation. Do not use both to say the same thing.

Containers: `--container-content: 720px` (app views via `max-w-content`), `--container-shell: 1080px` (marketing via `max-w-shell`). Base: 16px/1.5, `font-sans` antialiased, headings weight 400 with `-0.01em` tracking.

## Typography

Fonts are already wired in `src/app/layout.tsx`: Geist (`--font-sans`), Geist Mono (`--font-mono`), Instrument Serif (`--font-display`). NEVER add a font.

- Sans (Geist): prose, headings fallback, labels, controls, tables, KPIs, counts, dates. Mono (Geist Mono): code, timestamps, hour headers, `client_id`-style identifiers, status readouts — the identifier only, never its sentence. Display (Instrument Serif): hero, section titles, view titles, large stats, wordmark.
- Established sizes — reuse, do not invent: hero `font-display clamp(44px,7vw,84px)/1.05/-0.02em`; section `h2 font-display 40px/1.05/-0.02em`; feature `h3 font-display 32px/1.05/-0.02em`; view `h1 font-display 34px/1.1`; stat `font-display 32px`; body `text-sm leading-relaxed`; secondary `text-muted-foreground`; micro `text-xs text-ink-tertiary`.
- Eyebrow/Kicker: `text-xs font-medium tracking-[0.08em] uppercase text-ink-tertiary`. Sentence-case headings that state the claim or question. No all-caps body, no tracked kickers beyond this one, no em dashes in UI copy.
- Prose measure ~60–68ch (`max-w-[34rem]`–`max-w-[40rem]` patterns exist); rewrite before shrinking type. Tabular numerals for aligned comparisons. One `h1` per page/view; ordered headings after it.

## Layout

- Marketing `Section` (`src/app/page.tsx`): `border-t py-24` (`py-14` under 720px), inner `mx-auto max-w-shell px-6`. Hero variant only: `border-t-0 text-center`.
- App `ViewSection` (`primitives.tsx`): `mx-auto w-full max-w-content flex-1 flex-col gap-6`. Every view stays mounted, toggled `hidden`.
- App shell (`app-shell.tsx` + `sidebar.tsx`): `min-h-dvh grid-cols-[244px_minmax(0,1fr)]`, `main` padded `p-6 pt-10`; at `max-[820px]` single column with a fixed bottom bar `h-[var(--ec-nav-h)]` (the view buttons + Settings; the account menu is desktop-only, and account links move into the settings sheet). Views come from `NAV` in `sidebar.tsx`: For you, Sources, Memory, then All day, Day and Live only while `CAPTURE_ENABLED` (`src/lib/shared/features.ts`). Desktop rail order: wordmark, views, then pinned to the bottom Settings and the account menu (which opens upward, `side="top"`) above a `border-t`.
- View header: `ViewTitle` plus an optional lede `mt-2 max-w-[34rem] text-sm leading-relaxed text-muted-foreground`. For you replaces the title with a date line and a greeting (set after mount, never during SSR) and puts its one action (Refresh) at the right.
- View sections: `section.flex.flex-col.gap-3` headed by `Kicker as="h2" className="mb-0"`; lists of rows are one `ul.divide-y.rounded-lg.border.bg-card` with `p-3` rows, never a card per row.
- Mobile bottom-bar height is the `--ec-nav-h: 3.5rem` token (`globals.css`): the bar itself (`sidebar.tsx`), the `ActionBar` offset (`primitives.tsx`) and `main`'s bottom padding (`app-shell.tsx`) all read it — never hardcode that height.
- Sidebar: `sticky top-0 h-dvh flex-col gap-4 border-r bg-muted p-4`. Nav buttons `h-9 rounded-sm text-sm text-muted-foreground hover:bg-accent`; active `bg-card font-medium text-foreground shadow-ec-sm`.
- `ActionBar`: `sticky bottom-0 mt-auto flex justify-center gap-2 border-t bg-background/88 p-3 backdrop-blur-[8px]`. Primary action first, `outline` for the rest.
- `CardGrid`: `grid-cols-2 gap-3`, single column under 720px. Never nest cards in cards; a table/chart/review with 5+ columns owns full width instead of squeezing beside prose.
- Sheet (`settings-sheet.tsx`): `w-[min(560px,calc(100vw-2rem))]`, header `border-b`, body `flex-col gap-6 overflow-y-auto p-4`. Section state lives in hooks outside unmounting content.
- Search dropdown (`day-view.tsx`): `absolute top-[calc(100%+4px)] max-h-[50vh] overflow-y-auto rounded-sm border bg-card p-1 shadow-ec-md`.
- Grid children get `min-width: 0`; reflow before shrinking; never conceal page overflow. Gutters unmistakable; no stranded narrow track next to empty columns; no large accidental empty rectangles — rebalance or stack.

## Components (reuse, do not re-style)

- `Button` (`ui/button.tsx`): variants `default / destructive / outline / secondary / ghost / link`; sizes `xs / sm / default(h-9) / lg / icon*`. Marketing CTA size is `h-11 rounded-sm px-6 text-sm font-medium`. Keep `transition-all` debt where it is; new code names exact properties (`transition-[color,box-shadow]`, `transition-transform`).
- `Card` choice: app views and marketing use the local `Card` in `primitives.tsx` / `Mock` in `mock.tsx` (`rounded-lg border bg-card p-4`, `shadow-ec-md` for mocks). The shadcn `ui/card.tsx` is reserved for centered auth-style panels (signin uses `max-w-[22rem] p-8`). Do not mix the two on one surface.
- `Chip`/`chipClass`: `rounded-full border border-input px-3 py-1 text-xs text-muted-foreground`, ellipsis at `max-w-[22rem]`; interactive chips add `hover:bg-card hover:text-foreground`. `Chips` wraps `mt-3 flex flex-wrap gap-2`.
- `Kicker`, `Eyebrow`, `Note` (`text-xs text-muted-foreground`), `Empty` (`text-sm text-muted-foreground`), `FieldLabel` (`text-[13px] text-muted-foreground`), `Stat` (display number + muted label, `rounded-lg border bg-card p-4 text-center`).
- `Input`/`Label`/`Textarea`: shadcn defaults with `focus-visible:border-ring ring-ring/50`. Search inputs keep `aria-label`; date chip keeps a real `<label>`.
- `Tabs`: Day view uses `variant="line"` full-width left-aligned list with underline indicator; keep `forceMount` + `data-[state=inactive]:hidden` pattern.
- `Sheet`/`Dialog`/`Dropdown`: Radix via shadcn; popovers scale from trigger (`transform-origin: var(--transform-origin)`); modals stay centered. Sheet close button and `onOpenAutoFocus` focus management stay as built.
- Toasts: Sonner via `ui/sonner.tsx` (`theme="light"`, radius from `--radius`); custom `AlertToast` is `w-[320px] rounded-sm bg-primary text-primary-foreground shadow-ec-md`, flag accent via `border-l-[3px] border-brand`. Non-urgent auto-dismisses ~12s; high urgency persists with explicit Dismiss. Timers pause when tab hidden (Sonner default — keep it).
- `LiveDot`: `size-1.5 rounded-full bg-ink-tertiary`, live adds `animate-pulse bg-brand`. Only live indicator; never decorative pulse elsewhere.
- `IconTile` (`primitives.tsx`): lucide icon `size-4` on `size-9 rounded-sm bg-muted`. The one way to mark a source, an import row or a recommendation kind; the landing mocks use a `size-8` copy (`Tile`).
- `StatusLine`: `role="status"` progress/outcome text, `text-sm text-muted-foreground`, spinner only while busy. Long actions (imports, refresh, search) report through it rather than toasts.
- `ConfirmButton`: ghost `sm` trigger → `AlertDialog` with a destructive action. Required for anything that deletes imported data or learned memories (Remove import, Disconnect). Forgetting one memory is a plain `icon-sm` ghost `X` with an `aria-label`; its `title` says earcue won't learn it again.
- Recommendation card (`home-view.tsx`): `Card` with `IconTile` + kind label + relative time, `font-medium` title, muted detail, optional draft in `rounded-sm bg-muted p-3`, evidence as one `text-xs text-ink-tertiary line-clamp-2` "Based on …" line, then actions: `Copy reply` (primary, drafts only), `Read reply` (outline), `Done`, `Not useful` (ghost). Done cards drop to `bg-transparent shadow-none` inside a closed `<details>`.
- Source tile (`sources-view.tsx`): `Card` in a `CardGrid`; `IconTile` + name + a status line with a check when something is connected or added; blurb; a `<details>` "How do I …?" with an ordered list of steps; actions pinned with `mt-auto`. Unavailable connectors show a disabled outline "Coming soon" button.
- Drop zone: `rounded-lg border border-dashed border-input px-6 py-8 text-center`, drag-over `border-foreground bg-card`, one primary "Choose a file", `StatusLine` beneath.
- Memory view order (`memory-view.tsx`): header, the Ask form and its answers, "What earcue knows about you", "Tell earcue something", then "What earcue has learned". The search stays the first thing on the view; the profile opens the part about what earcue holds.
- Profile section ("What earcue knows about you"): one `Card`, the summary as its first `p`, then two lists side by side, `Kicker as="h3"` "Always true" (static facts) and "Right now" (dynamic facts), in `grid grid-cols-2 gap-4` (single column under 720px), items `text-sm` in a `ul.flex.flex-col.gap-1.5`. A `Note` under the card says the profile is built from the memories below and when it next refreshes (a forget or an edit marks it stale; it rebuilds on the next catch-up). No controls on the facts: they carry no memory ids, so editing happens on the memories. Empty profile: `Empty` copy, no card. Sensitive memories never reach the profile.
- Learned list: grouped by kind in the order People, Preferences, Goals, Projects, Routines, Facts, Moments. Each group is a `Kicker as="h3"` with the count, then the standard `ul.divide-y.rounded-lg.border.bg-card` rows, first 8 rows then an outline `sm` "Show all N". Each row ends with Edit (ghost `icon-sm` pencil) and Forget (ghost `icon-sm` `X`), both with `aria-label`s naming the memory. Edit turns the row, in place, into a form: a `Textarea` prefilled with the text, then Save (default `sm`) and Cancel (ghost `sm`); saving disables both and keeps the text, a failure shows `text-xs text-destructive` with `role="alert"`. No motion on either change.
- Private (sensitive) memories: hidden from the Learned list by default, shown by one `Chip` with `aria-pressed`, "Show private N", only when N > 0. Not persisted: every visit starts hidden. Shown rows keep the `LockIcon` "private" label.
- Getting-started checklist (For you, until a source, a memory and a recommendation all exist): `Card p-6`, `font-display 26px` heading, numbered `size-6 rounded-full border` markers that invert to `bg-foreground` with a check when done.
- `Wordmark`: display serif 22px with accent dot; single instance per header/sidebar/footer.

## Color discipline

- Default surface progression: `bg-background` page → `bg-card` raised → `bg-muted` sunken/rails. Dividers `border`; inputs `border-input`.
- `text-brand` / `bg-brand` / `bg-brand-soft` / `border-brand` only for live state, flags, and primary evidence (recording banner, flag rows, accent bar on flagged toast, the `size-1.5` dot beside "Needs you soon" on a high-urgency recommendation, `bg-brand-soft` behind matched words in a search snippet, the dot on the landing "Free during early access" pill). Never for favorable numbers, longer bars, or decoration.
- `text-destructive` only for errors and destructive actions. Urgent flag border in `alert-toasts.tsx` stays as built.
- Focus always visible: `:focus-visible { outline: 2px solid var(--ec-focus); outline-offset: 2px; }`. Never remove outlines to "clean up".
- Image-like edges: `1px` outline at low opacity, pure black light-mode (`oklch(0 0 0 / 0.1)`); never tinted neutrals.

## Motion

Default to stillness. Animate only to explain a state change, preserve continuity, confirm a press, or prevent a jarring appear/disappear. If purpose is "looks cool" on a frequent path, do not animate.

- Landing hero only: one staged entrance per page load (`animate-in fade-in-0 slide-in-from-bottom-2 fill-mode-both duration-300 ease-out`, `delay-75`…`delay-300` down the hero). No entrance motion anywhere in `/app`.
- Frequency gate: keyboard-initiated or 100+/day actions get no animation; tens/day get ≤150ms opacity/color or nothing; occasional (modals, drawers, toasts, sheets) standard below; rare/first-run may add delight.
- Durations (stay under 300ms for UI): press feedback 100–160ms; tooltips/popovers 125–200ms; dropdowns/selects 150–250ms; modals/drawers/sheets 200–500ms. Stagger only infrequent staged entrances: 30–80ms between items (better-ui allows ~100ms for hierarchy chunks); never block interaction; `initial={false}` on first render.
- Easing: entering/exiting → ease-out; on-screen move/morph → ease-in-out; hover/color → ease; constant motion → linear. NEVER `ease-in` for UI. Prefer strong custom curves over built-ins: `--ease-out: cubic-bezier(0.23,1,0.32,1)`, `--ease-in-out: cubic-bezier(0.77,0,0.175,1)`, drawer `cubic-bezier(0.32,0.72,0,1)`.
- Properties: only `transform` and `opacity` (plus `filter: blur(≤4px)` for icon cross-fades). Name exact properties; NEVER `transition: all`. Update `transform` directly on the dragged element, never a parent CSS variable (recalc cost). `will-change` only for `transform/opacity/filter` when first-frame stutter is observed.
- Press: buttons and toast actions scale `0.97` on `:active`; chips and nav buttons scale `0.98` (never below 0.95); add an opt-out only where motion distracts.
- Enter: never from `scale(0)`; start `scale(0.95–0.97)` + `opacity: 0`. Exits softer than enters: small fixed `translateY`, ease-out both ways. Prefer CSS transitions (interruptible, retarget mid-flight) over keyframes for anything rapidly retriggered (toasts, toggles); reserve keyframes for run-once staged sequences. Entry without JS: `@starting-style`; percentages for self-sized moves (`translateY(100%)`).
- Icons: cross-fade with `opacity 0→1`, `scale 0.25→1`, `blur 4px→0px`; Motion users `transition: { type: "spring", duration: 0.3, bounce: 0 }`, else dual-DOM cross-fade with `cubic-bezier(0.2,0,0,1)`. One icon library per surface (lucide here); `currentColor` recolored per state; stroke `1.5px` beside regular text, `2px` beside semibold.
- Springs only for drag/momentum/interruptible gestures (`{ type: "spring", duration: 0.5, bounce: 0.1–0.3 }`); flick-to-dismiss uses velocity (`|distance|/ms > ~0.11` dismisses); dampen at boundaries; capture pointer; ignore extra touch points. This product has no drag surfaces today — do not add spring infrastructure until one ships.
- Touch: gate hover motion behind `@media (hover:hover) and (pointer:fine)`. Reduced motion: keep opacity/color comprehension cues, remove positional movement (`prefers-reduced-motion: reduce`, `useReducedMotion` where Motion is used).
- Debug: replay at 10% speed in the Animations panel; check origin, sync of opacity/transform/color, and interrupt mid-flight.

## Data, evidence, and empty states

- Numbers that must align share one lane, one scale, tabular numerals; exact values adjacent to any bar/track. Zero baselines for length; never crop bars to exaggerate or flatten to hide deltas. Direct labels over legends.
- Tables: semantic `<table>` with caption; full evidence width; text left / numeric right including headers (`vbg-numeric`-style discipline, no `vbg-*` classes here); body `vertical-align: baseline`; row-label column wide enough to avoid wrapping short labels; group repeated categories instead of repeating a column.
- Reviews, timelines, suggestions: one evidence home per claim; later views may link back, not restate at equal prominence. Timestamps as evidence (`fmtHour`, hour headers sticky with `bg-background`).
- Empty/loading/error are first-class states with `Empty`/`Note` copy (e.g. "No traces for this day yet.", "Review in progress — press Refresh…"). Every animated change also has a static cue (color, icon, label).

## Accessibility

- Landmarks, one `h1`, skip link (in `layout.tsx` — keep), native controls with visible labels, semantic tables/figures, visible focus, AA contrast, never color alone. Source order is reading order.
- Touch targets ≥24px (buttons `h-9`+; `icon-xs h-6` only for dense repeated rows with equivalent click area nearby). Icon-only buttons keep `sr-only` labels.
- Preserve invalid input plus last valid result; never silently clamp. Announce async results (`role="alert"` for form errors; toast region for flags).

## Never ship

No decorative gradients/glows/blobs/stripes/textures/glass/paper/fake depth; no generic centered-hero-plus-card-grid beyond the existing landing; no metric-box grids where one composed relationship works; no pills/badges for ordinary metadata; no nested panels; no dark rounded rectangle around every chart; no mixed icon sets or oversized decorative icons; no tiny gray body copy to force density; no `dark:`-only styling; no new fonts, themes, or token families; no animation on keyboard paths; no `transition: all`; no `scale(0)` entrances; no center-origin popovers; no keyframes on rapidly-triggered UI; no motion as the only feedback channel.

## Adding or changing UI

1. Reuse `primitives.tsx`, `mock.tsx`, `ui/*` as mapped above. New surface? Copy the nearest existing one first.
2. Tokens only from the table above via Tailwind (`bg-card`, `text-muted-foreground`, `border-input`, `text-brand`, `shadow-ec-md`, `max-w-content/shell`, `rounded-sm/lg`, `font-display/mono`). No hex literals outside `globals.css`.
3. Hierarchy via type/scale/spacing first; add a border or surface only to communicate grouping, selection, or state.
4. States: default, hover (gated), focus-visible, active (`scale(0.97)` / `0.98` for chips and nav), loading, empty, error. Verify each by reading code; with a browser, replay motion at 10% speed.
5. Keep `/app` views mounted + `hidden`, sheet state outside unmounting content, `localStorage` reads after mount, capture/pipeline state module-scoped.
6. Update this file in the same commit when adding a component, token, motion value, or layout pattern — stale design docs are bugs, same as stale code.
