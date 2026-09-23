import type { GmailMessage } from "@/lib/shared/gmail";

// Builders for the synthetic archives the evals import. Everything here is invented: the person,
// their colleagues and every address live under the reserved `.example` TLD. Times are hours before
// the run starts, so a fixture means the same thing ("owed since yesterday", "promised three weeks
// ago") whenever it runs.

export const SELF = { name: "Alex Moreno", email: "alex.moreno@brightfield.example", tz: "Europe/Lisbon" };
const ME = `${SELF.name} <${SELF.email}>`;

export const PEOPLE = {
  tom: "Tom Keller <tom.keller@brightfield.example>",
  priya: "Priya Shah <priya.shah@brightfield.example>",
  lena: "Lena Park <lena.park@brightfield.example>",
  ines: "Inês Moreno <ines.moreno@mail.example>",
};

export interface Mail {
  // Also the fixture's label for the item: the Gmail id becomes external_id `gm:<id>`.
  id: string;
  hoursAgo: number;
  from?: string;
  to?: string;
  subject: string;
  text: string;
  // Written by the person (Gmail's SENT label); `from` defaults to them.
  sent?: boolean;
  labels?: string[];
  thread?: string;
}

export interface Chat {
  name: string;
  messages: { hoursAgo: number; from: string; text: string }[];
}

export interface Archive {
  mails: Mail[];
  chats: Chat[];
}

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");

// The shape Gmail's users.messages.get(format=full) answers with, so gmailItem() parses it exactly
// as it parses a real backfill.
export function gmailMessage(m: Mail, now: number): GmailMessage {
  const from = m.from ?? ME;
  const to = m.to ?? ME;
  return {
    id: m.id,
    threadId: m.thread ?? `t-${m.id}`,
    internalDate: String(Math.round(now - m.hoursAgo * 3600_000)),
    labelIds: m.labels ?? (m.sent ? ["SENT"] : ["INBOX"]),
    snippet: m.text.slice(0, 120),
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "Subject", value: m.subject },
        { name: "From", value: from },
        { name: "To", value: to },
      ],
      parts: [
        { mimeType: "text/plain", body: { data: b64(m.text) } },
        { mimeType: "text/html", body: { data: b64(`<p>${m.text}</p>`) } },
      ],
    },
  };
}

// A WhatsApp "Export chat -> Without media" file in the US Android format (M/D/YY, h:mm AM). That
// format parses the same whatever the day of the month, where a day-first export whose days are
// all 12 or under would be read month-first. Local time, as parseWhatsappExport reads it.
export function whatsappExport(chat: Chat, now: number): string {
  const lines = [...chat.messages]
    .sort((a, b) => b.hoursAgo - a.hoursAgo)
    .map((msg) => {
      const d = new Date(now - msg.hoursAgo * 3600_000);
      const h = d.getHours() % 12 || 12;
      const ampm = d.getHours() < 12 ? "AM" : "PM";
      const date = `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`;
      return `${date}, ${h}:${String(d.getMinutes()).padStart(2, "0")} ${ampm} - ${msg.from}: ${msg.text}`;
    });
  return [`${lines.length ? lines[0].split(" - ")[0] : "1/1/26, 9:00 AM"} - Messages and calls are end-to-end encrypted.`, ...lines].join("\n");
}

// "Friday 25 September", a day count from the run's start, for text that names a date.
export function dayName(now: number, daysAhead: number): string {
  return new Date(now + daysAhead * 86400_000).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: SELF.tz });
}

const d = (days: number) => days * 24;

// The person every fixture shares: a product lead at a small software company in Lisbon, running
// an onboarding redesign ("Atlas"). Mostly older than the briefing's 72-hour inbox window, so
// each fixture's own items are what the inbox shows; the recent ones need nothing from them.
export function baseArchive(): Archive {
  return {
    mails: [
      {
        id: "base-kickoff",
        hoursAgo: d(45),
        from: PEOPLE.tom,
        to: `${ME}, ${PEOPLE.priya}, ${PEOPLE.lena}`,
        subject: "Project Atlas kickoff",
        text: "Hi all, we're kicking off Project Atlas, the onboarding redesign. Alex owns the roadmap and the launch, Priya leads pricing, Lena owns design. Target launch is October 15. Tom",
      },
      {
        id: "base-sync",
        hoursAgo: d(44),
        sent: true,
        to: `${PEOPLE.tom}, ${PEOPLE.priya}, ${PEOPLE.lena}`,
        subject: "Atlas weekly sync",
        text: "Let's keep a weekly Atlas sync on Tuesdays at 10:00 Lisbon time. I'll send short notes after each one. Alex",
      },
      {
        id: "base-mockups",
        hoursAgo: d(30),
        from: PEOPLE.lena,
        subject: "Atlas onboarding mockups v1",
        text: "First pass of the new onboarding flow is in Figma: a three-step signup with a progressive profile. Comments welcome. Lena",
      },
      {
        id: "base-mockups-reply",
        hoursAgo: d(29),
        sent: true,
        to: PEOPLE.lena,
        thread: "t-base-mockups",
        subject: "Re: Atlas onboarding mockups v1",
        text: "Love the three-step flow. Let's drop the phone number field entirely: fewer fields always wins for us. Alex",
      },
      {
        id: "base-pricing-research",
        hoursAgo: d(20),
        from: PEOPLE.priya,
        subject: "Atlas pricing research",
        text: "Summary of the pricing interviews: customers anchor on per-seat pricing, and 60% prefer annual billing. Full notes in the Atlas folder. Priya",
      },
      {
        id: "base-status",
        hoursAgo: d(15),
        sent: true,
        to: PEOPLE.tom,
        subject: "Atlas status",
        text: "Design is on track, pricing is still open, and the launch is still October 15. Alex",
      },
      {
        id: "base-climbing",
        hoursAgo: d(10),
        from: "Climbhouse Lisboa <members@climbhouse.example>",
        subject: "Your membership renews next month",
        text: "Hi Alex, your Climbhouse monthly membership renews automatically on the 1st. See you on the wall!",
      },
      {
        id: "base-lunch",
        hoursAgo: d(7),
        sent: true,
        to: PEOPLE.ines,
        subject: "Sunday lunch",
        text: "I'll bring dessert on Sunday. See you at Mum's around one. Alex",
      },
      {
        id: "base-leadership",
        hoursAgo: 60,
        from: PEOPLE.tom,
        subject: "Notes from leadership sync",
        text: "FYI, no action needed: leadership agreed the Q4 priorities and Atlas remains the top one. Tom",
      },
      {
        id: "base-build",
        hoursAgo: 40,
        from: "Build bot <ci@brightfield.example>",
        subject: "Nightly build passed",
        text: "All 412 checks passed on main.",
      },
      {
        id: "base-figma",
        hoursAgo: 18,
        from: PEOPLE.lena,
        subject: "Figma comments resolved",
        text: "All comments on the v3 mockups are resolved. Nothing needed from you. Lena",
      },
    ],
    chats: [
      {
        name: "Inês Moreno",
        messages: [
          { hoursAgo: d(34), from: "Inês Moreno", text: "Are you running the Lisbon half again this year?" },
          { hoursAgo: d(34) - 1, from: SELF.name, text: "Yes! Training three mornings a week before work." },
          { hoursAgo: d(34) - 2, from: "Inês Moreno", text: "Show-off. Mum wants everyone at lunch on Sunday." },
          { hoursAgo: d(33), from: SELF.name, text: "I'll be there." },
          { hoursAgo: d(26), from: "Inês Moreno", text: "Did you book the flights for Christmas in Porto?" },
          { hoursAgo: d(26) - 1, from: SELF.name, text: "Not yet, I always wait for the train sale instead. Much nicer than flying." },
        ],
      },
    ],
  };
}
