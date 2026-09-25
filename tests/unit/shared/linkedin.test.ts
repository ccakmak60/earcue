import { describe, expect, it } from "vitest";
import { isLinkedinExport, linkedinDate, linkedinFileOf, linkedinKey, parseCsv, parseLinkedinExport, selfKeyOf, type LinkedinChatItem } from "@/lib/shared/importers/linkedin";

// Shaped like LinkedIn's "Download your data" CSVs (header names as LinkedIn writes them); the
// people and companies are made up.
const PROFILE = "First Name,Last Name,Maiden Name,Address,Birth Date,Headline,Summary,Industry,Zip Code,Geo Location,Twitter Handles,Websites,Instant Messengers\r\nAlex,Moreno,,,,Product engineer,\"Builds tools, mostly for small teams.\",Software,,Lisbon,,,\r\n";
const POSITIONS = "Company Name,Title,Description,Location,Started On,Finished On\nAtlas Labs,Senior Engineer,Payments platform,Lisbon,Mar 2021,\nNorthwind,Engineer,,Porto,Jan 2018,Feb 2021\n";
const SKILLS = "Name\nTypeScript\nPostgres\n";
const MESSAGES = [
  "CONVERSATION ID,CONVERSATION TITLE,FROM,SENDER PROFILE URL,TO,RECIPIENT PROFILE URLS,DATE,SUBJECT,CONTENT,FOLDER,IS MESSAGE DRAFT",
  "c1,,Inês Carvalho,https://www.linkedin.com/in/ines-carvalho,Alex Moreno,https://www.linkedin.com/in/alexmoreno,2024-03-05 14:22:11 UTC,,\"Hi Alex, are you open to a chat about the staff role?\",INBOX,No",
  "c1,,Alex Moreno,https://www.linkedin.com/in/alexmoreno,Inês Carvalho,https://www.linkedin.com/in/ines-carvalho,2024-03-05 15:01:00 UTC,,\"Yes, Thursday works.\nMorning is best.\",INBOX,No",
  "c1,,Alex Moreno,https://www.linkedin.com/in/alexmoreno,Inês Carvalho,https://www.linkedin.com/in/ines-carvalho,2024-03-06 09:00:00 UTC,,unsent draft,INBOX,Yes",
  "c2,Atlas hiring,Marco Tavares,https://www.linkedin.com/in/marco%C3%A9t,Alex Moreno,https://www.linkedin.com/in/alexmoreno,2024-04-01 08:00:00 UTC,,<p>Congrats on the launch!</p>,INBOX,No",
  "c3,,Spammer,https://www.linkedin.com/in/spam,Alex Moreno,https://www.linkedin.com/in/alexmoreno,2024-04-02 08:00:00 UTC,,Buy followers,SPAM,No",
].join("\n");
const CONNECTIONS =
  "Notes:\n\"When exporting your connection data, you may notice that some of the email addresses are missing.\"\n\n" +
  "First Name,Last Name,URL,Email Address,Company,Position,Connected On\n" +
  "Inês,Carvalho,https://www.linkedin.com/in/ines-carvalho,,Acme,Recruiter,05 Mar 2024\n" +
  "Marco,Tavares,https://www.linkedin.com/in/marcoet,marco@x.example,Atlas Labs,CTO,28 Mar 2024\n" +
  "Dana,Silva,https://www.linkedin.com/in/dana,,,,02 Jan 2023\n";
const APPLICATIONS =
  "Application Date,Contact Email,Contact Phone Number,Company Name,Job Title,Job Url,Resume Name,Question And Answers\n" +
  "\"3/7/24, 2:22 PM\",alex@example.com,,Acme,Staff Engineer,https://www.linkedin.com/jobs/view/123,alex-cv.pdf,Years of TypeScript? 6\n";
const SHARES = "Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility\n2024-04-01 07:30:00,https://www.linkedin.com/feed/update/urn:li:share:9,\"We shipped Atlas payments today.\",,,MEMBER_NETWORK\n2024-04-02 07:30:00,https://www.linkedin.com/feed/update/urn:li:share:10,,https://x.example,,MEMBER_NETWORK\n";

const EXPORTED = Date.UTC(2024, 5, 1);

describe("parseCsv", () => {
  it("keeps commas, doubled quotes and line breaks inside quoted fields, and drops a BOM", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi""\nthere"\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"\nthere'],
    ]);
  });
});

describe("recognising the archive", () => {
  it("needs Profile.csv plus messages or connections, in any folder", () => {
    expect(isLinkedinExport(["Profile.csv", "messages.csv"])).toBe(true);
    expect(isLinkedinExport(["Basic_LinkedInDataExport_06-01-2024/Profile.csv", "Basic_LinkedInDataExport_06-01-2024/Connections.csv"])).toBe(true);
    expect(isLinkedinExport(["messages.csv"])).toBe(false);
    expect(isLinkedinExport(["_chat.txt"])).toBe(false);
    expect(linkedinFileOf("Jobs/Job Applications_1.csv")).toBe("applications");
    expect(linkedinFileOf("Invitations.csv")).toBeNull();
  });
});

describe("linkedinDate and linkedinKey", () => {
  it("reads the three date formats the archive uses, as UTC", () => {
    expect(linkedinDate("2024-03-05 14:22:11 UTC")).toBe(Date.UTC(2024, 2, 5, 14, 22, 11));
    expect(linkedinDate("05 Mar 2024")).toBe(Date.UTC(2024, 2, 5));
    expect(linkedinDate("3/7/24, 2:22 PM")).toBe(Date.UTC(2024, 2, 7, 14, 22));
    expect(linkedinDate("12/1/24, 12:05 AM")).toBe(Date.UTC(2024, 11, 1, 0, 5));
    expect(linkedinDate("soon")).toBeNull();
  });

  it("keys a person by their profile URL, never their name", () => {
    expect(linkedinKey("https://www.linkedin.com/in/Ines-Carvalho/")).toBe("linkedin:ines-carvalho");
    expect(linkedinKey("https://www.linkedin.com/in/marco%C3%A9t?trk=x")).toBe("linkedin:marcoét");
    expect(linkedinKey("")).toBeNull();
  });
});

describe("parseLinkedinExport", () => {
  it("turns conversations into chat blocks keyed by profile, skipping drafts and spam", async () => {
    const items = await parseLinkedinExport({ profile: PROFILE, messages: MESSAGES }, EXPORTED);
    const chats = items.filter((i): i is LinkedinChatItem => i.kind === "chat");
    expect(chats).toHaveLength(2);
    const [c1, c2] = chats;
    expect(c1.title).toBe("LinkedIn — Inês Carvalho");
    expect(c1.meta.messageCount).toBe(2);
    expect(c1.body).toBe("2024-03-05 14:22 Inês Carvalho: Hi Alex, are you open to a chat about the staff role?\n2024-03-05 15:01 Alex Moreno: Yes, Thursday works.\nMorning is best.");
    expect(c1.meta.people).toEqual([
      { key: "linkedin:ines-carvalho", name: "Inês Carvalho" },
      { key: "linkedin:alexmoreno", name: "Alex Moreno" },
    ]);
    expect(c1.meta.members).toEqual(["linkedin:ines-carvalho", "linkedin:alexmoreno"]);
    expect(c1.externalId).toMatch(/^li:[0-9a-f]{32}:\d+$/);
    expect(c2.title).toBe("LinkedIn — Atlas hiring");
    expect(c2.body).toBe("2024-04-01 08:00 Marco Tavares: Congrats on the launch!");
    // Alex is on the conversation but did not write in it: Marco alone spoke.
    expect(c2.meta.people).toEqual([{ key: "linkedin:marcoét", name: "Marco Tavares" }]);
    expect(c2.meta.members).toEqual(["linkedin:marcoét", "linkedin:alexmoreno"]);
  });

  it("lists only the people who spoke in a block, not everyone on the conversation", async () => {
    const header = MESSAGES.split("\n")[0];
    const rows = [
      "c5,,Inês Carvalho,https://www.linkedin.com/in/ines-carvalho,Alex Moreno,https://www.linkedin.com/in/alexmoreno,2024-03-05 10:00:00 UTC,,First question?,INBOX,No",
      "c5,,Alex Moreno,https://www.linkedin.com/in/alexmoreno,Inês Carvalho,https://www.linkedin.com/in/ines-carvalho,2024-03-05 11:00:00 UTC,,An answer.,INBOX,No",
      ...Array.from({ length: 40 }, (_, i) => `c5,,Inês Carvalho,https://www.linkedin.com/in/ines-carvalho,Alex Moreno,https://www.linkedin.com/in/alexmoreno,2024-03-06 10:${String(i).padStart(2, "0")}:00 UTC,,Follow-up ${i}?,INBOX,No`),
    ];
    const chats = (await parseLinkedinExport({ messages: [header, ...rows].join("\n") }, EXPORTED)).filter((i): i is LinkedinChatItem => i.kind === "chat");
    expect(chats).toHaveLength(2);
    expect(chats[0].meta.people.map((p) => p.key)).toEqual(["linkedin:ines-carvalho", "linkedin:alexmoreno"]);
    expect(chats[1].meta.people.map((p) => p.key)).toEqual(["linkedin:ines-carvalho"]);
    expect(chats[1].meta.participants).toEqual(["Inês Carvalho"]);
  });

  it("names a recipient from Connections.csv when a comma in their name breaks the TO cell", async () => {
    const header = MESSAGES.split("\n")[0];
    const row = 'c6,,Alex Moreno,https://www.linkedin.com/in/alexmoreno,"Inês Carvalho, PMP",https://www.linkedin.com/in/ines-carvalho,2024-03-05 10:00:00 UTC,,Hello,INBOX,No';
    const [chat] = (await parseLinkedinExport({ profile: PROFILE, messages: `${header}\n${row}`, connections: CONNECTIONS }, EXPORTED)).filter((i): i is LinkedinChatItem => i.kind === "chat");
    expect(chat.title).toBe("LinkedIn — Inês Carvalho");
  });

  it("decodes HTML in a message once, so escaped markup stays escaped", async () => {
    const header = MESSAGES.split("\n")[0];
    const row = "c7,,Inês Carvalho,https://www.linkedin.com/in/ines-carvalho,Alex Moreno,https://www.linkedin.com/in/alexmoreno,2024-03-05 10:00:00 UTC,,<p>use &amp;lt;br&amp;gt; &amp; <b>bold</b></p>,INBOX,No";
    const [chat] = await parseLinkedinExport({ messages: `${header}\n${row}` }, EXPORTED);
    expect(chat.body).toBe("2024-03-05 10:00 Inês Carvalho: use &lt;br&gt; & bold");
  });

  it("keeps every block under the items endpoint's body limit, a long message included", async () => {
    const header = MESSAGES.split("\n")[0];
    const rows = [
      `c8,,Inês Carvalho,https://www.linkedin.com/in/ines-carvalho,Alex Moreno,https://www.linkedin.com/in/alexmoreno,2024-03-05 10:00:00 UTC,,${"a".repeat(2400)},INBOX,No`,
      `c8,,Inês Carvalho,https://www.linkedin.com/in/ines-carvalho,Alex Moreno,https://www.linkedin.com/in/alexmoreno,2024-03-05 10:01:00 UTC,,${"b".repeat(6000)},INBOX,No`,
    ];
    const chats = await parseLinkedinExport({ messages: [header, ...rows].join("\n") }, EXPORTED);
    expect(chats).toHaveLength(2);
    for (const c of chats) expect(c.body.length).toBeLessThan(4000);
  });

  it("splits a long conversation into blocks of at most 40 messages", async () => {
    const header = MESSAGES.split("\n")[0];
    const rows = Array.from({ length: 45 }, (_, i) => `c9,,Inês Carvalho,https://www.linkedin.com/in/ines-carvalho,Alex Moreno,https://www.linkedin.com/in/alexmoreno,2024-03-05 10:${String(i).padStart(2, "0")}:00 UTC,,ok ${i},INBOX,No`);
    const chats = await parseLinkedinExport({ messages: [header, ...rows].join("\n") }, EXPORTED);
    expect(chats.map((c) => (c as LinkedinChatItem).meta.messageCount)).toEqual([40, 5]);
    expect(new Set(chats.map((c) => c.externalId)).size).toBe(2);
  });

  it("makes a document per profile section", async () => {
    const [profile, experience, skills] = await parseLinkedinExport({ profile: PROFILE, positions: POSITIONS, skills: SKILLS }, EXPORTED);
    expect(profile).toMatchObject({ externalId: "li:profile", kind: "doc", title: "Your LinkedIn profile", ts: new Date(EXPORTED).toISOString() });
    expect(profile.body).toContain("Headline: Product engineer");
    expect(profile.body).toContain("Builds tools, mostly for small teams.");
    expect(experience).toMatchObject({ externalId: "li:profile:experience", title: "Your experience on LinkedIn" });
    expect(experience.body).toContain("- Senior Engineer at Atlas Labs (Mar 2021 – present), Lisbon: Payments platform");
    expect(skills).toMatchObject({ externalId: "li:profile:skills", body: "Skills:\nTypeScript, Postgres" });
  });

  it("splits a long career across documents instead of losing education and skills", async () => {
    const long = "Company Name,Title,Description,Location,Started On,Finished On\n" + Array.from({ length: 8 }, (_, i) => `Co ${i},Engineer,"${"x".repeat(700)}",Lisbon,Jan 201${i},`).join("\n");
    const education = "School Name,Start Date,End Date,Notes,Degree Name,Activities\nUniversity of Porto,2010,2014,,BSc Computer Science,\n";
    const items = await parseLinkedinExport({ profile: PROFILE, positions: long, education, skills: SKILLS }, EXPORTED);
    expect(items.map((i) => i.externalId)).toEqual(["li:profile", "li:profile:experience", "li:profile:experience:2", "li:profile:education", "li:profile:skills"]);
    for (const i of items) expect(i.body.length).toBeLessThan(4000);
    expect(items[3].body).toContain("University of Porto, BSc Computer Science (2010 – 2014)");
  });

  it("makes a document per application and per post with text, and one per month of connections", async () => {
    const items = await parseLinkedinExport({ applications: APPLICATIONS + APPLICATIONS.split("\n")[0] + "\n", shares: SHARES, connections: CONNECTIONS }, EXPORTED);
    const application = items.find((i) => i.title.startsWith("Applied"));
    expect(application).toMatchObject({ title: "Applied: Staff Engineer at Acme", ts: new Date(Date.UTC(2024, 2, 7, 14, 22)).toISOString(), url: "https://www.linkedin.com/jobs/view/123" });
    expect(application?.body).toContain("Screening answers:\nYears of TypeScript? 6");
    expect(items.filter((i) => i.title.startsWith("Applied"))).toHaveLength(1);

    const posts = items.filter((i) => i.title === "Your LinkedIn post");
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toBe("We shipped Atlas payments today.");

    const connections = items.filter((i) => i.externalId.startsWith("li:connections:"));
    expect(connections.map((i) => i.externalId)).toEqual(["li:connections:2023-01", "li:connections:2024-03"]);
    expect(connections[1].body).toContain("- Inês Carvalho, Recruiter at Acme (connected 2024-03-05)");
    expect(connections[1].body).toContain("- Marco Tavares, CTO at Atlas Labs (connected 2024-03-28) marco@x.example");
  });
});

describe("selfKeyOf", () => {
  const names = new Map([
    ["linkedin:me", "John Smith"],
    ["linkedin:other-john", "John Smith"],
    ["linkedin:ines", "Inês Carvalho"],
  ]);

  it("takes the one profile on every conversation, not a namesake who wrote once", () => {
    const members = [new Set(["linkedin:other-john", "linkedin:me"]), new Set(["linkedin:ines", "linkedin:me"])];
    expect(selfKeyOf(members, names, "John Smith")).toBe("linkedin:me");
  });

  it("uses the name only to choose between profiles on every conversation", () => {
    expect(selfKeyOf([new Set(["linkedin:ines", "linkedin:me"])], names, "John Smith")).toBe("linkedin:me");
    expect(selfKeyOf([new Set(["linkedin:other-john", "linkedin:me"])], names, "John Smith")).toBeNull();
    expect(selfKeyOf([new Set(["linkedin:ines", "linkedin:me"])], names, "")).toBeNull();
  });
});
