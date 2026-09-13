import type { Metadata } from "next";
import Link from "next/link";
import { Eyebrow, FeatureRow, Mock } from "@/components/marketing/mock";
import { Button } from "@/components/ui/button";
import { Wordmark } from "@/components/wordmark";
import { cn } from "@/lib/utils";

const DESCRIPTION =
  "Earcue listens while you live your day, hands you the line you need in the moment, and writes an honest debrief at night. Runs in your browser. Private by default.";

export const metadata: Metadata = {
  title: { absolute: "earcue — a quiet record of your day" },
  description: DESCRIPTION,
  openGraph: { title: "earcue — a quiet record of your day", description: DESCRIPTION },
};

const cta = "h-11 rounded-sm px-6 text-sm font-medium";

function Section({ id, className, children }: { id?: string; className?: string; children: React.ReactNode }) {
  return (
    <section id={id} className={cn("border-t py-24 max-[720px]:py-14", className)}>
      <div className="mx-auto max-w-shell px-6">{children}</div>
    </section>
  );
}

function SectionHead({ eyebrow, title }: { eyebrow?: string; title: string }) {
  return (
    <div className="mb-16 text-center">
      {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
      <h2 className="mt-3 font-display text-[40px] leading-[1.05] tracking-[-0.02em]">{title}</h2>
    </div>
  );
}

function Toast({ flagged, children }: { flagged?: boolean; children: React.ReactNode }) {
  return (
    <div className={cn("rounded-sm bg-primary p-3 text-sm text-primary-foreground [&+&]:mt-2", flagged && "border-l-[3px] border-brand")}>{children}</div>
  );
}

function PrivacyItem({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-lg font-semibold">{title}</h3>
      {children && <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{children}</p>}
    </div>
  );
}

const privacyGrid = "mt-16 grid grid-cols-2 gap-6 max-[720px]:grid-cols-1";

export default function LandingPage() {
  return (
    <>
      <nav className="sticky top-0 z-[100] border-b bg-background/88 backdrop-blur-[8px]">
        <div className="mx-auto flex h-18 max-w-shell items-center justify-between px-6">
          <Wordmark />
          <div className="flex items-center gap-6 text-sm text-muted-foreground max-[720px]:gap-3 [&>a:not([data-slot=button]):hover]:text-foreground">
            <a href="#how">How it works</a>
            <a href="#private">Private</a>
            <a href="#faq">Questions</a>
            <Link href="/signin">Sign in</Link>
            <Button asChild className="h-[38px] rounded-sm px-4">
              <Link href="/app">Open earcue</Link>
            </Button>
          </div>
        </div>
      </nav>

      <main id="main">
        <Section className="border-t-0 text-center">
          <h1 className="font-display text-[clamp(44px,7vw,84px)] leading-[1.05] tracking-[-0.02em]">A quiet record of your day.</h1>
          <p className="mx-auto mt-6 max-w-[30rem] text-xl text-muted-foreground">
            Earcue listens while you live your day, hands you the line you need in the moment, and writes an honest debrief at night.
          </p>
          <div className="mt-10 flex justify-center gap-3">
            <Button asChild className={cta}>
              <Link href="/app">Open earcue</Link>
            </Button>
            <Button asChild variant="outline" className={cn(cta, "bg-transparent")}>
              <a href="#day">See a day</a>
            </Button>
          </div>
          <div className="mt-16 flex flex-wrap justify-center text-sm text-muted-foreground [&>span]:border-l [&>span]:px-6 [&>span:first-child]:border-l-0">
            <span>Runs in your browser, nothing to install</span>
            <span>Private by default: you set retention, you set the blocklist</span>
            <span>Built for your life, not your meetings</span>
          </div>

          <Mock className="mx-auto mt-16 max-w-[640px] text-left shadow-ec-lg">
            <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
              <span className="size-2 animate-pulse rounded-full bg-brand" />
              listening
            </div>
            <div className="my-4 font-display text-[30px] leading-[1.2]">Ask her what she&apos;s actually worried about. Don&apos;t fix it yet.</div>
            <div className="text-[13px] leading-relaxed text-ink-tertiary">
              &hellip;so I told them I&apos;d have it by Friday, which is insane
              <br />
              I mean it&apos;s fine, it&apos;s just a lot right now
            </div>
          </Mock>
        </Section>

        <Section id="how">
          <SectionHead eyebrow="How it works" title="Four moments of a day." />

          <FeatureRow
            eyebrow="In the moment"
            title="A line, when you go blank."
            body={
              <>
                Tell Earcue who you&apos;re with and who you want in your ear. It listens to the room and drafts your next sentence: warm friend, blunt coach,
                whoever you need. Hit &ldquo;Give me a line&rdquo; or just let it keep up.
              </>
            }
          >
            <Mock>
              <div className="mb-4 flex gap-2 text-xs">
                <span className="rounded-full bg-primary px-3 py-1 text-primary-foreground">Warm, funny friend</span>
                <span className="rounded-full border border-input px-3 py-1 text-muted-foreground">Custom</span>
              </div>
              <div className="font-display text-2xl leading-[1.3]">Tell her the truth: you&apos;re proud of her and you&apos;re also scared.</div>
            </Mock>
          </FeatureRow>

          <FeatureRow
            reverse
            eyebrow="All day"
            title="Capture that gets out of the way."
            body="One tap starts ambient capture: microphone, and your screen if you want it. Chunks transcribe and sync in the background while minutes, traces and anything still pending stay on screen."
          >
            <Mock>
              <div className="mb-4 rounded-sm border border-input p-2 text-center text-sm">recording &middot; screen paused</div>
              <div className="flex justify-around text-xs text-muted-foreground [&_strong]:block [&_strong]:text-[13px] [&_strong]:text-foreground">
                <div>
                  <strong>214</strong>minutes captured
                </div>
                <div>
                  <strong>96</strong>traces synced
                </div>
                <div>
                  <strong>2</strong>pending
                </div>
              </div>
            </Mock>
          </FeatureRow>

          <FeatureRow
            eyebrow="Only when it matters"
            title="It stays quiet, mostly."
            body="Earcue watches a minute at a time and almost always says nothing. It speaks up for a promise you just made, a claim worth checking, or a moment where you contradicted yourself."
          >
            <Mock>
              <Toast flagged>commitment &middot; you said you&apos;d call your mum back tonight</Toast>
              <Toast>
                factcheck &middot; &ldquo;the pharmacy closes at 6&rdquo; (it closes at 8 on Saturdays)
                <button type="button" className="mt-2 block rounded-sm border border-primary-foreground/22 px-2 py-1 text-xs">
                  Check it
                </button>
              </Toast>
            </Mock>
          </FeatureRow>

          <FeatureRow
            reverse
            eyebrow="At night"
            title="The debrief you'd never write yourself."
            body="Where the hours actually went, your longest stretch of focus, every promise you made and whether you kept it, and what to do differently tomorrow, with timestamps as evidence. It is deliberately unflattering."
          >
            <Mock>
              <div className="grid grid-cols-2 gap-4 text-sm max-[720px]:grid-cols-1 [&_h4]:mb-1 [&_h4]:text-[13px] [&_h4]:font-medium [&_h4]:text-ink-tertiary">
                <div>
                  <h4>Wins</h4>
                  <p>Finally called the dentist (11:14)</p>
                </div>
                <div>
                  <h4>Time</h4>
                  <div className="border-b py-1">Deep work 96m &middot; 41%</div>
                  <div className="py-1">Errands &amp; admin 42m &middot; 18%</div>
                </div>
                <div>
                  <h4>Commitments</h4>
                  <p>&ldquo;I&apos;ll send the photos tonight&rdquo; (13:02, open)</p>
                </div>
                <div>
                  <h4>Tomorrow</h4>
                  <p>Start the day on the thing you avoided at 15:40</p>
                </div>
              </div>
            </Mock>
          </FeatureRow>
        </Section>

        <Section id="day" className="bg-muted">
          <FeatureRow
            eyebrow="Any day"
            title="Scrub back through it."
            body="Every day lands on an hour-by-hour timeline you can open any time: what you said, what you heard, what was on the screen. Nothing to file, nothing to name."
          >
            <Mock>
              <div className="text-sm [&_h5]:mb-1 [&_h5]:text-[13px] [&_h5]:font-medium [&_h5]:text-ink-tertiary [&>div+div]:mt-4 [&_p]:border-b [&_p]:py-1 [&_p:last-child]:border-b-0">
                <div>
                  <h5>09:00</h5>
                  <p>09:12 stand-up with yourself: three things, one of them real</p>
                  <p>09:41 screen: the same tab you opened yesterday</p>
                </div>
                <div>
                  <h5>13:00</h5>
                  <p>13:05 lunch with Sam, the job thing came up again</p>
                  <p className="text-brand">13:22 flag: promised Sam an intro by Thursday</p>
                </div>
                <div>
                  <h5>16:00</h5>
                  <p>16:03 phone call, mostly listening</p>
                  <p>16:38 screen: drifting</p>
                </div>
              </div>
            </Mock>
          </FeatureRow>
        </Section>

        <Section id="private">
          <SectionHead eyebrow="Private" title="Nobody else is in the room." />
          <div className={privacyGrid}>
            <PrivacyItem title="Sign in with Google or a password.">
              Use Google or an email and password. Passwords are stored only as a salted hash — never in plaintext.
            </PrivacyItem>
            <PrivacyItem title="You set the retention.">Local audio is kept for three days by default. Older chunks are swept away.</PrivacyItem>
            <PrivacyItem title="Blocklist anything.">
              List words like banking or 1password and matching screens are dropped before they ever leave the browser.
            </PrivacyItem>
            <PrivacyItem title="Screen is optional.">
              Pause it whenever. Audio keeps going, and you can bring the screen back with one tap.
            </PrivacyItem>
          </div>
        </Section>

        <Section id="faq">
          <SectionHead title="Questions." />
          <div className="[&_details]:border-b [&_details]:py-4 [&_details:first-child]:border-t [&_p]:mt-3 [&_p]:max-w-[40rem] [&_p]:text-sm [&_p]:leading-relaxed [&_p]:text-muted-foreground [&_summary]:flex [&_summary]:cursor-pointer [&_summary]:list-none [&_summary]:items-center [&_summary]:justify-between [&_summary]:text-[17px] [&_summary]:after:text-xl [&_summary]:after:text-ink-tertiary [&_summary]:after:transition-transform [&_summary]:after:content-['+'] [&_details[open]_summary]:after:rotate-45 [&_summary::-webkit-details-marker]:hidden">
            <details>
              <summary>Do I need to install anything?</summary>
              <p>
                No. Earcue is a web app. Open it in a Chromium browser, allow the microphone, and it runs. Screen capture and the wake lock need that browser too.
              </p>
            </details>
            <details>
              <summary>Is this for meetings?</summary>
              <p>
                It will happily sit through one, but it is built for the rest of your day: the phone calls, the kitchen conversations, the two hours you cannot
                account for.
              </p>
            </details>
            <details>
              <summary>Where does my audio go?</summary>
              <p>
                Chunks are transcribed by Gemini and the resulting text lines (transcripts and screen captions) are stored on our servers. The raw audio stays on
                your device and expires on your retention setting; it is never uploaded. See{" "}
                <Link href="/privacy" className="underline">
                  privacy
                </Link>{" "}
                for the full picture.
              </p>
            </details>
            <details>
              <summary>Will it interrupt me all the time?</summary>
              <p>
                No. The watcher looks at a minute at a time and emitting nothing is the normal outcome. You will hear from it for a promise, a checkable claim, or a
                contradiction.
              </p>
            </details>
            <details>
              <summary>What does it cost?</summary>
              <p>Nothing right now &mdash; earcue is free while it&rsquo;s in testing.</p>
            </details>
          </div>
        </Section>

        <Section id="pricing">
          <SectionHead eyebrow="Pricing" title="Free while we’re in testing." />
          <div className={privacyGrid}>
            <PrivacyItem title="Up to 4 hours/day of speech capture" />
            <PrivacyItem title="Up to 360 screen frames/day" />
            <PrivacyItem title="Up to 200 watch checks/day" />
            <PrivacyItem title="Up to 2 day reviews/day" />
          </div>
          <p className="mt-6">
            <Button asChild className={cta}>
              <Link href="/signin">Get started</Link>
            </Button>
          </p>
        </Section>

        <Section className="bg-primary text-center text-primary-foreground">
          <h2 className="font-display text-5xl leading-[1.05] tracking-[-0.02em]">Start with today.</h2>
          <p className="mt-4 mb-10 text-lg opacity-85">It only needs the next hour to be worth reading tonight.</p>
          <Button asChild className={cn(cta, "bg-background text-foreground hover:bg-background/90")}>
            <Link href="/app">Open earcue</Link>
          </Button>
        </Section>
      </main>

      <footer className="border-t py-6 text-[13px] text-muted-foreground">
        <div className="mx-auto flex max-w-shell items-center justify-between px-6">
          <Wordmark />
          <span>a personal daily record</span>
          <span>
            <Link href="/privacy">Privacy</Link> &middot; <Link href="/terms">Terms</Link>
          </span>
        </div>
      </footer>
    </>
  );
}
