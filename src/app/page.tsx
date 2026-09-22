import type { Metadata } from "next";
import Link from "next/link";
import {
  BellIcon,
  BookmarkIcon,
  BrainIcon,
  CalendarIcon,
  CheckIcon,
  FileTextIcon,
  HashIcon,
  HistoryIcon,
  LayersIcon,
  LightbulbIcon,
  LockIcon,
  MailIcon,
  MessageCircleIcon,
  PenLineIcon,
  SearchIcon,
  SparklesIcon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import { Eyebrow, FeatureRow, Mock } from "@/components/marketing/mock";
import { Button } from "@/components/ui/button";
import { Wordmark } from "@/components/wordmark";
import { cn } from "@/lib/utils";

const DESCRIPTION =
  "earcue reads the mail, chats and pages you already have, learns what matters to you, and tells you the few things worth doing next. Read-only, and you can remove anything.";

export const metadata: Metadata = {
  title: { absolute: "earcue — your next steps, from what you already have" },
  description: DESCRIPTION,
  openGraph: { title: "earcue — your next steps, from what you already have", description: DESCRIPTION },
};

const cta = "h-11 rounded-sm px-6 text-sm font-medium";

// Staged hero entrance: runs once per page load, so it may take the rare-path budget (DESIGN.md Motion).
const rise = "animate-in fade-in-0 slide-in-from-bottom-2 fill-mode-both duration-300 ease-out";

function Section({ id, className, children }: { id?: string; className?: string; children: React.ReactNode }) {
  return (
    <section id={id} className={cn("border-t py-24 max-[720px]:py-14", className)}>
      <div className="mx-auto max-w-shell px-6">{children}</div>
    </section>
  );
}

function SectionHead({ eyebrow, title, lede }: { eyebrow?: string; title: string; lede?: string }) {
  return (
    <div className="mb-16 text-center">
      {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
      <h2 className="mt-3 font-display text-[40px] leading-[1.05] tracking-[-0.02em]">{title}</h2>
      {lede && <p className="mx-auto mt-4 max-w-[34rem] text-muted-foreground">{lede}</p>}
    </div>
  );
}

function Tile({ icon: Icon }: { icon: React.ComponentType<{ className?: string }> }) {
  return (
    <span aria-hidden="true" className="grid size-8 flex-none place-items-center rounded-sm bg-muted">
      <Icon className="size-4" />
    </span>
  );
}

function RecMock({
  icon,
  kind,
  urgent,
  title,
  detail,
  draft,
  className,
}: {
  icon: React.ComponentType<{ className?: string }>;
  kind: string;
  urgent?: boolean;
  title: string;
  detail: string;
  draft?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-3 rounded-lg border bg-card p-4 shadow-ec-sm", className)}>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <Tile icon={icon} />
        <span>{kind}</span>
        {urgent && (
          <span className="flex items-center gap-1 text-foreground">
            <span className="size-1.5 rounded-full bg-brand" />
            Needs you soon
          </span>
        )}
      </div>
      <div>
        <div className="font-medium">{title}</div>
        <div className="mt-1 text-sm leading-relaxed text-muted-foreground">{detail}</div>
      </div>
      {draft && <div className="rounded-sm bg-muted p-3 text-sm leading-relaxed">{draft}</div>}
      {draft && (
        <div className="flex gap-2 text-xs">
          <span className="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground">Copy reply</span>
          <span className="flex items-center gap-1 rounded-md px-3 py-1.5 font-medium">
            <CheckIcon className="size-3" />
            Done
          </span>
        </div>
      )}
    </div>
  );
}

function HeroMock() {
  const nav = [
    { icon: SparklesIcon, label: "For you", active: true },
    { icon: LayersIcon, label: "Sources" },
    { icon: BrainIcon, label: "Memory" },
  ];
  return (
    <div className="mx-auto mt-16 max-w-[900px] overflow-hidden rounded-lg border bg-background text-left shadow-ec-lg" aria-hidden="true">
      <div className="flex gap-1.5 border-b bg-card px-4 py-3">
        <span className="size-2 rounded-full bg-input" />
        <span className="size-2 rounded-full bg-input" />
        <span className="size-2 rounded-full bg-input" />
      </div>
      <div className="grid grid-cols-[180px_minmax(0,1fr)] max-[720px]:grid-cols-1">
        <div className="flex flex-col gap-1 border-r bg-muted p-3 max-[720px]:hidden">
          <Wordmark className="mb-3 px-2 text-lg" />
          {nav.map(({ icon: Icon, label, active }) => (
            <span key={label} className={cn("flex h-8 items-center gap-2 rounded-sm px-2 text-sm text-muted-foreground", active && "bg-card text-foreground shadow-ec-sm")}>
              <Icon className="size-4" />
              {label}
            </span>
          ))}
        </div>
        <div className="flex flex-col gap-4 p-6 max-[720px]:p-4">
          <div>
            <div className="text-sm text-muted-foreground">Thursday, 9 October</div>
            <div className="font-display text-[30px] leading-[1.1]">Good morning, Sam.</div>
          </div>
          <div className="text-xs font-medium tracking-[0.08em] text-ink-tertiary uppercase">For you today</div>
          <RecMock
            icon={PenLineIcon}
            kind="Reply"
            urgent
            title="Confirm Saturday's table with Maya"
            detail="She asked twice whether 7pm still works. You told Leo on Tuesday that it does."
            draft="Hi Maya, yes, 7pm works for us. I'll book for six and send the address tonight."
          />
          <div className="grid grid-cols-2 gap-4 max-[720px]:grid-cols-1">
            <RecMock icon={BellIcon} kind="Reminder" title="Bring the signed lease on Thursday" detail="Flat viewing at 18:30, and Harbour Lettings asked for it by email." />
            <RecMock
              icon={LightbulbIcon}
              kind="Idea"
              title="Start the 10k plan you saved"
              detail="You bookmarked it in March and told Priya you want to run the half in May."
              className="max-[720px]:hidden"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

const SOURCES: { icon: React.ComponentType<{ className?: string }>; label: string }[] = [
  { icon: MailIcon, label: "Gmail" },
  { icon: CalendarIcon, label: "Google Calendar" },
  { icon: HashIcon, label: "Slack" },
  { icon: MessageCircleIcon, label: "WhatsApp" },
  { icon: BookmarkIcon, label: "Bookmarks" },
  { icon: HistoryIcon, label: "Browsing history" },
  { icon: FileTextIcon, label: "Notes & documents" },
];

const STEPS = [
  {
    title: "Add what you already have",
    body: "Connect Gmail and Calendar in one click, or drop in a WhatsApp chat, your bookmarks or a page of notes. Step-by-step help for every export.",
  },
  {
    title: "earcue learns what matters",
    body: "It picks out the people, projects, plans and preferences in your life and keeps them current as new mail arrives.",
  },
  {
    title: "Get a short list of next steps",
    body: "The reply you owe, the meeting to prepare for, the idea you saved and forgot. Copy a reply, mark it done, move on.",
  },
];

function PrivacyItem({ icon, title, children }: { icon: React.ComponentType<{ className?: string }>; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4">
      <Tile icon={icon} />
      <div>
        <h3 className="font-medium">{title}</h3>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{children}</p>
      </div>
    </div>
  );
}

export default function LandingPage() {
  return (
    <>
      <nav className="sticky top-0 z-[100] border-b bg-background/88 backdrop-blur-[8px]">
        <div className="mx-auto flex h-18 max-w-shell items-center justify-between px-6">
          <Wordmark />
          <div className="flex items-center gap-6 text-sm text-muted-foreground max-[720px]:gap-3 [&>a:not([data-slot=button]):hover]:text-foreground">
            <a href="#how" className="max-[720px]:hidden">
              How it works
            </a>
            <a href="#private" className="max-[720px]:hidden">
              Privacy
            </a>
            <a href="#pricing" className="max-[720px]:hidden">
              Pricing
            </a>
            <Link href="/signin">Sign in</Link>
            <Button asChild className="h-[38px] rounded-sm px-4">
              <Link href="/app">Get started</Link>
            </Button>
          </div>
        </div>
      </nav>

      <main id="main">
        <Section className="border-t-0 pt-20 text-center">
          <div className={cn(rise, "inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1 text-xs text-muted-foreground")}>
            <span className="size-1.5 rounded-full bg-brand" aria-hidden="true" />
            Free during early access
          </div>
          <h1 className={cn(rise, "mx-auto mt-6 max-w-[14ch] font-display text-[clamp(44px,7vw,84px)] leading-[1.05] tracking-[-0.02em] delay-75")}>
            Your life already has the answers.
          </h1>
          <p className={cn(rise, "mx-auto mt-6 max-w-[34rem] text-xl leading-relaxed text-muted-foreground delay-150")}>
            earcue reads the mail, chats and pages you already have, learns what matters to you, and tells you the few things worth doing next.
          </p>
          <div className={cn(rise, "mt-10 flex flex-wrap justify-center gap-3 delay-200")}>
            <Button asChild className={cta}>
              <Link href="/app">Get started free</Link>
            </Button>
            <Button asChild variant="outline" className={cn(cta, "bg-transparent")}>
              <a href="#how">See how it works</a>
            </Button>
          </div>
          <div className={cn(rise, "mt-8 flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm text-muted-foreground delay-300")}>
            <span className="flex items-center gap-1.5">
              <CheckIcon className="size-4" aria-hidden="true" /> Read-only access
            </span>
            <span className="flex items-center gap-1.5">
              <CheckIcon className="size-4" aria-hidden="true" /> Remove anything, any time
            </span>
            <span className="flex items-center gap-1.5">
              <CheckIcon className="size-4" aria-hidden="true" /> Nothing to install
            </span>
          </div>

          <div className={cn(rise, "delay-300")}>
            <HeroMock />
          </div>
        </Section>

        <section aria-labelledby="worksWith" className="border-t py-12">
          <div className="mx-auto max-w-shell px-6 text-center">
            <h2 id="worksWith" className="text-sm text-muted-foreground">
              Works with what you already use
            </h2>
            <ul className="mt-6 flex flex-wrap justify-center gap-3">
              {SOURCES.map(({ icon: Icon, label }) => (
                <li key={label} className="flex items-center gap-2 rounded-full border bg-card py-1.5 pr-4 pl-3 text-sm">
                  <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
                  {label}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <Section id="how">
          <SectionHead eyebrow="How it works" title="Three steps, about five minutes." lede="No setup calls, no training, no folders to organise. Bring one source and see what earcue finds." />
          <ol className="grid grid-cols-3 gap-10 max-[900px]:grid-cols-1">
            {STEPS.map((step, i) => (
              <li key={step.title} className="border-t pt-6">
                <div className="font-display text-[44px] leading-none text-ink-tertiary tabular-nums">0{i + 1}</div>
                <h3 className="mt-4 font-display text-[26px] leading-[1.1]">{step.title}</h3>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{step.body}</p>
              </li>
            ))}
          </ol>
        </Section>

        <Section className="bg-muted">
          <FeatureRow
            eyebrow="Sources"
            title="Drop in an export. earcue works out the rest."
            body="A WhatsApp chat, a Google Takeout zip, a bookmarks file or a page of notes all go in the same place. Every source shows exactly what it added, and removing it removes what earcue learned from it."
          >
            <Mock>
              <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-input px-6 py-8 text-center">
                <Tile icon={UploadIcon} />
                <div className="font-medium">Drop any export here</div>
                <div className="text-sm text-muted-foreground">Adding 1,840 of 2,300…</div>
              </div>
              <div className="mt-4 divide-y rounded-lg border bg-card text-sm">
                {[
                  { icon: MessageCircleIcon, label: "Family group", meta: "WhatsApp · 2,300 items" },
                  { icon: MailIcon, label: "Gmail", meta: "Connected · 4,112 items" },
                  { icon: BookmarkIcon, label: "bookmarks.html", meta: "Bookmarks · 612 items" },
                ].map(({ icon, label, meta }) => (
                  <div key={label} className="flex items-center gap-3 p-3">
                    <Tile icon={icon} />
                    <div>
                      <div className="font-medium">{label}</div>
                      <div className="text-xs text-muted-foreground">{meta}</div>
                    </div>
                  </div>
                ))}
              </div>
            </Mock>
          </FeatureRow>
        </Section>

        <Section>
          <FeatureRow
            reverse
            eyebrow="Memory"
            title="Ask it anything you've been told."
            body="Which restaurant did Priya recommend? When is the lease up? What did you promise to send this week? earcue answers from your own sources and shows you where it found it."
          >
            <Mock>
              <div className="flex h-11 items-center gap-2 rounded-md border border-input bg-card px-3 text-sm">
                <SearchIcon className="size-4 text-ink-tertiary" />
                Which restaurant did Priya recommend?
              </div>
              <div className="mt-4 rounded-lg border bg-card p-4">
                <div className="flex gap-3">
                  <BrainIcon className="mt-0.5 size-4 flex-none text-ink-tertiary" />
                  <div>
                    <div className="text-sm">Priya recommended Sora, the Japanese place on Mill Street, for your anniversary.</div>
                    <div className="mt-1 text-xs text-muted-foreground">People</div>
                  </div>
                </div>
              </div>
              <div className="mt-3 flex items-center gap-3 rounded-lg border bg-card p-3 text-sm">
                <MessageCircleIcon className="size-4 text-ink-tertiary" />
                <span>
                  WhatsApp · Priya: &ldquo;you have to try <mark className="rounded-[2px] bg-brand-soft">Sora</mark>, get the omakase&rdquo;
                </span>
              </div>
            </Mock>
          </FeatureRow>

          <div className="mt-24">
            <FeatureRow
              eyebrow="You're in charge"
              title="See everything it knows. Correct anything."
              body="earcue shows every fact it has learned about you, grouped by people, projects, goals and preferences. Forget one with a tap. Health, money and other sensitive details stay out of recommendations entirely."
            >
              <Mock>
                <div className="mb-3 flex flex-wrap gap-2 text-xs">
                  <span className="rounded-full border border-input bg-card px-3 py-1">All 214</span>
                  <span className="rounded-full border border-input px-3 py-1 text-muted-foreground">People 38</span>
                  <span className="rounded-full border border-input px-3 py-1 text-muted-foreground">Projects 12</span>
                  <span className="rounded-full border border-input px-3 py-1 text-muted-foreground">Goals 6</span>
                </div>
                <div className="divide-y rounded-lg border bg-card text-sm">
                  {[
                    { text: "Training for the Bristol half marathon in May", kind: "Goals" },
                    { text: "Leo is your brother; his birthday is 14 March", kind: "People" },
                    { text: "Asked the GP about the knee follow-up", kind: "Facts", locked: true },
                  ].map((m) => (
                    <div key={m.text} className="flex items-start gap-3 p-3">
                      <div className="flex-1">
                        <div>{m.text}</div>
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          {m.kind}
                          {m.locked && (
                            <>
                              {" · "}
                              <LockIcon className="size-3" /> private
                            </>
                          )}
                        </div>
                      </div>
                      <XIcon className="size-4 text-ink-tertiary" />
                    </div>
                  ))}
                </div>
              </Mock>
            </FeatureRow>
          </div>
        </Section>

        <Section id="private" className="bg-muted">
          <SectionHead eyebrow="Privacy" title="Your data, on your terms." />
          <div className="grid grid-cols-2 gap-x-12 gap-y-10 max-[720px]:grid-cols-1">
            <PrivacyItem icon={LockIcon} title="Read-only, always.">
              earcue never sends, replies to, or changes anything in Gmail, Calendar or Slack. You copy a suggested reply and send it yourself.
            </PrivacyItem>
            <PrivacyItem icon={LayersIcon} title="Only what you add.">
              Nothing is read until you connect or upload it. Block whole websites, like your bank, from ever being imported.
            </PrivacyItem>
            <PrivacyItem icon={XIcon} title="Remove means remove.">
              Delete a source and what earcue learned only from it goes too. Forget a single fact, or delete your account and everything with it.
            </PrivacyItem>
            <PrivacyItem icon={BrainIcon} title="Sensitive stays quiet.">
              Health, money, legal and intimate details are marked private. You can still search them; recommendations never bring them up.
            </PrivacyItem>
          </div>
          <p className="mt-10 text-center text-sm text-muted-foreground">
            Read the full{" "}
            <Link href="/privacy" className="underline">
              privacy policy
            </Link>
            .
          </p>
        </Section>

        <Section id="pricing">
          <SectionHead eyebrow="Pricing" title="Free while we're in early access." />
          <div className="mx-auto max-w-[28rem] rounded-lg border bg-card p-8 shadow-ec-md">
            <div className="flex items-baseline gap-2">
              <span className="font-display text-[56px] leading-none">$0</span>
              <span className="text-sm text-muted-foreground">during early access</span>
            </div>
            <ul className="mt-6 flex flex-col gap-3 text-sm">
              {[
                "Every source: Gmail, Calendar, Slack, WhatsApp, bookmarks, history, documents",
                "Daily recommendations with ready-to-send replies",
                "Ask your memory anything",
                "Remove any source or fact, any time",
              ].map((line) => (
                <li key={line} className="flex gap-3">
                  <CheckIcon className="mt-0.5 size-4 flex-none" aria-hidden="true" />
                  {line}
                </li>
              ))}
            </ul>
            <Button asChild className={cn(cta, "mt-8 w-full")}>
              <Link href="/signin">Get started</Link>
            </Button>
          </div>
        </Section>

        <Section id="faq">
          <SectionHead title="Questions." />
          <div className="mx-auto max-w-[44rem] [&_details]:border-b [&_details]:py-4 [&_details:first-child]:border-t [&_p]:mt-3 [&_p]:max-w-[40rem] [&_p]:text-sm [&_p]:leading-relaxed [&_p]:text-muted-foreground [&_summary]:flex [&_summary]:cursor-pointer [&_summary]:list-none [&_summary]:items-center [&_summary]:justify-between [&_summary]:text-[17px] [&_summary]:after:text-xl [&_summary]:after:text-ink-tertiary [&_summary]:after:transition-transform [&_summary]:after:content-['+'] [&_details[open]_summary]:after:rotate-45 [&_summary::-webkit-details-marker]:hidden">
            <details>
              <summary>Do I need to install anything?</summary>
              <p>No. earcue runs in your browser. Sign in, connect an account or drop in a file, and it gets to work.</p>
            </details>
            <details>
              <summary>What can earcue see?</summary>
              <p>
                Only what you give it. Gmail and Calendar are read-only; WhatsApp, bookmarks and history come from exports you choose to upload. Every source is
                listed in one place, with a Remove button.
              </p>
            </details>
            <details>
              <summary>Where does my data go?</summary>
              <p>
                Imported text is stored with your account and processed by Azure OpenAI so earcue can learn from it. See{" "}
                <Link href="/privacy" className="underline">
                  privacy
                </Link>{" "}
                for the full picture.
              </p>
            </details>
            <details>
              <summary>Will it nag me?</summary>
              <p>No. earcue suggests at most a few things at a time and says nothing when nothing needs you. Mark a suggestion &ldquo;not useful&rdquo; and it steers away from that kind of thing.</p>
            </details>
            <details>
              <summary>What does it cost?</summary>
              <p>Nothing during early access.</p>
            </details>
          </div>
        </Section>

        <Section className="bg-primary text-center text-primary-foreground">
          <h2 className="font-display text-5xl leading-[1.05] tracking-[-0.02em]">Start with one chat.</h2>
          <p className="mx-auto mt-4 mb-10 max-w-[30rem] text-lg opacity-85">Drop in a single WhatsApp export and see what earcue finds in it.</p>
          <Button asChild className={cn(cta, "bg-background text-foreground hover:bg-background/90")}>
            <Link href="/app">Get started free</Link>
          </Button>
        </Section>
      </main>

      <footer className="border-t py-6 text-[13px] text-muted-foreground">
        <div className="mx-auto flex max-w-shell flex-wrap items-center justify-between gap-3 px-6">
          <Wordmark />
          <span>Your next steps, from what you already have</span>
          <span>
            <Link href="/privacy">Privacy</Link> &middot; <Link href="/terms">Terms</Link>
          </span>
        </div>
      </footer>
    </>
  );
}
