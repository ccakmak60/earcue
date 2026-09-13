import { Button } from "@/components/ui/button";

export function OnboardCard({ onDismiss }: { onDismiss: () => void }) {
  return (
    <section className="mb-6 max-w-[32rem] rounded-lg border bg-card p-6 shadow-ec-sm [&_a]:underline [&>p]:mt-3">
      <h2 className="mb-2 text-[13px] font-semibold">Two ways to use earcue</h2>
      <p>
        <strong>In the moment</strong> listens on demand and hands you a line when you ask. <strong>All day</strong> captures continuously in the background and
        writes a nightly debrief.
      </p>
      <p>
        What gets uploaded: your speech is transcribed to text and stored on our servers; short screen captions are too, unless a frame is flagged sensitive or
        matches your blocklist. Raw audio stays on your device and is never uploaded &mdash; see <a href="/privacy">privacy</a>.
      </p>
      <Button variant="outline" className="mt-4" onClick={onDismiss}>
        Got it
      </Button>
    </section>
  );
}
