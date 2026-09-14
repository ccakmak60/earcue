import { Button } from "@/components/ui/button";

export function OnboardCard({ onDismiss }: { onDismiss: () => void }) {
  return (
    <section
      role="region"
      aria-label="How earcue works"
      className="mb-6 max-w-[32rem] rounded-lg border bg-card p-6 shadow-ec-sm animate-in fade-in-0 slide-in-from-top-1 duration-200 ease-out [&_a]:underline [&>p]:mt-3"
    >
      <h2 className="mb-2 text-[13px] font-semibold">How earcue works</h2>
      <p>
        <strong>All day</strong> captures continuously in the background and writes a day review. <strong>Assist</strong> hands you a line whenever you ask for
        one.
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
