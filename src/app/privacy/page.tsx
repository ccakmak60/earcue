import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/marketing/legal-page";

export const metadata: Metadata = { title: "Privacy" };

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy">
      <p className="text-xs">This describes what the current code actually does, not aspirational policy.</p>

      <h2>What stays on your device</h2>
      <p>
        Raw audio lives only in your browser&apos;s local storage (IndexedDB) until it has been transcribed, at which point it is deleted immediately &mdash; it is
        never uploaded to our servers. The retention window you set (3 days by default) applies only to audio that has not yet been uploaded (for example while
        offline); that backlog is swept away automatically once it expires.
      </p>

      <h2>What is uploaded and stored</h2>
      <p>
        Transcribed speech (text, not audio) and screen captions &mdash; short descriptions and salient text extracted from your screen &mdash; are uploaded to
        Azure OpenAI for processing and the resulting text is stored in our Postgres database, tied to your account.
      </p>

      <h2>Model run records</h2>
      <p>
        Each time earcue asks the model for recommendations, builds memories from your imports, or answers you in Ask earcue, it keeps a short record
        of that run: which model and instruction version ran, how long it took, how many tokens it used, how it ended, and the internal ids of the
        items and memories it read and produced. The record holds no text from your mail, chats, documents, or memories, and no copy of the
        model&apos;s answer. We use it to find out why a recommendation appeared and whether a change made them better. Records are deleted
        automatically once they are 30 days old, and immediately when you delete your account.
      </p>
      <p>
        There is one exception to &ldquo;no text&rdquo;. When Ask earcue looks something up for you, the record keeps what it looked up: the search
        words, a person&apos;s name or address, or the dates it checked, up to 200 characters each. These are usually words from your own question, so
        search text you type into Ask earcue stays in the run record for up to 30 days. The conversation itself is not stored on our servers: it lives
        in your browser tab until you reload or start a new one. Only the memories it adds, forgets or changes are kept, as memories. When a message
        of yours leads earcue to remember something, that one message is also kept, word for word, as a note: the memories point back to it, and
        you can find the whole message again by searching. Messages that change nothing are not kept.
      </p>

      <h2>Signals on imported items</h2>
      <p>
        earcue asks Azure OpenAI a few fixed questions about each imported email, chat, calendar event, document and page you read: whether it is worth
        keeping, how much it matters, whether you owe a reply, whether you promised something in it, and whether it is sensitive. The answers are
        numbers and short labels, stored with the item in our database. They are included in your export, and deleted with the item, its import, or
        your account. earcue uses the first two to decide what it learns from first: items that matter are read before others, and automated mail
        such as receipts and newsletters is read last. Nothing is deleted because of these answers. The last answer keeps sensitive items out of
        what earcue brings up on its own: an item appears in recommendations only once it has been asked about and judged not to reveal your health,
        money, legal matters or intimate life. When you ask earcue yourself, in Ask earcue or a memory search, it can still show them.
      </p>

      <h2>People, projects and ideas</h2>
      <p>
        earcue keeps a list of the people you correspond with, and of the projects, ideas, organisations and places your memories are about, so it can
        tell you what you last discussed with someone or pick up an idea you parked. Each entry holds a name, the addresses it goes by (email
        addresses, WhatsApp names, Slack ids), and links to the items and memories about it, and the list is built only from your own imports, memories
        and chats with earcue. It joins two addresses into one person on its own only when they are the same address, never by a name: a WhatsApp
        contact with the same name as a sender in your mail stays a separate entry until you merge them in the Memory view. If you tell earcue which
        WhatsApp name is yours, that name is added to your own entry. The list is included in your export, and deleted with your account; removing an
        import removes its items&apos; links, and forgetting a memory removes the memory&apos;s link.
      </p>

      <h2>What is still open</h2>
      <p>
        From those signals and the list above, earcue keeps a list of what is still open for you: a reply you owe, something you promised, an answer
        you are waiting for, someone you have not been in touch with for much longer than usual, or a project or idea with nothing new for weeks. Each
        entry holds only its kind, its status and the internal ids of the item and person or project it is about, no text. It closes on its own when
        you reply, get in touch or pick the project up again, and expires after a month. Recommendations are chosen from it: accepting one marks its
        entry done, and dismissing one marks it dismissed for good, so earcue does not raise it again. The list is included in your export and
        deleted with the item it rests on, its import, or your account.
      </p>

      <h2>Editing and forgetting memories</h2>
      <p>
        When you edit a memory, the new wording replaces it everywhere earcue uses it. The old wording is kept out of view as that memory&apos;s history
        and is included in your export; forgetting the memory deletes it.
      </p>
      <p>
        Ask earcue forgets or changes a memory only when your own message asks it to, never because an email or document it read says so. Before it
        does, it sends your last three messages in the conversation, and nothing else, to Azure OpenAI with one yes-or-no question: do they ask to
        forget or change something? Only the answer, a number, is kept in the run record.
      </p>
      <p>
        When you forget a memory, earcue deletes its text, the links to the mail, chats, or documents it came from, its earlier versions, anything
        earcue inferred from it, and the note of your own words it came from, if any. So that the same fact is not learned again from a later email or chat, earcue keeps a marker with three things: the
        kind of memory (for example &ldquo;person&rdquo; or &ldquo;preference&rdquo;), what it was about in lower case (often a name, such as
        &ldquo;marco&rdquo;), and its embedding. An embedding is a list of numbers the model computes from the text. It does not store the words, but it
        does roughly encode what the memory said. If you tell earcue that fact again yourself, the marker is removed. Markers are not in your export,
        because there is no text left in them, and they are deleted immediately when you delete your account.
      </p>

      <h2>Screen filtering, and its limits</h2>
      <p>
        Screen frames you flag as sensitive, or that match your blocklist words, are dropped before they are ever uploaded. This filter applies to screen captures
        only. <strong>Speech has no equivalent filter</strong> &mdash; everything you or people near you say while capturing is transcribed and uploaded. Do not use
        ambient capture around conversations you would not want recorded as text.
      </p>

      <h2>Sub-processors</h2>
      <p>
        Azure OpenAI (Microsoft) processes audio, screen frames, and text on our behalf to produce transcripts, captions, watch flags, day reviews, and memory
        embeddings. Polar processes subscription payments; we do not see or store your card details. Azure Database for PostgreSQL hosts our Postgres database.
      </p>

      <h2>Accounts</h2>
      <p>
        You can sign in with Google or with an email and password. Passwords are stored only as a salted hash, never in plaintext, and we send no email — there are
        no sign-in links or digest emails.
      </p>

      <h2>Your data, your control</h2>
      <p>
        From <Link href="/account">your account page</Link> you can export a copy of your data as JSON: your traces, day reviews, imported items,
        recommendations, the memories earcue has learned and what it has written about you, and the model run records described above. You can also
        permanently delete your account and all associated data.
      </p>

      <h2>Connected accounts</h2>
      <p>
        Connected accounts are read-only &mdash; earcue never sends or writes anything back to Gmail, Calendar, or Slack. Google access requests{" "}
        <code>gmail.readonly</code> and <code>calendar.readonly</code>; Slack access requests the user-scoped <code>channels:history</code>,{" "}
        <code>groups:history</code>, <code>im:history</code>, and <code>users:read</code>. OAuth tokens are stored AES-256-GCM encrypted, never in plaintext. Synced
        emails, events, and messages are deleted automatically after 30 days. Disconnecting a provider from the Sources page deletes that provider&apos;s
        synced items immediately.
      </p>

      <h2>Contact</h2>
      <p>Questions about this policy: reach us via the email address you signed up with, or the address on your billing receipt.</p>
    </LegalPage>
  );
}
