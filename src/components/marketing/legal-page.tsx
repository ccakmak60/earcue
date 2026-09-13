import { Wordmark } from "@/components/wordmark";

// Shared frame for the privacy and terms pages.
export function LegalPage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main
      id="main"
      className="mx-auto max-w-[42rem] px-6 pt-10 pb-16 leading-relaxed [&_a]:underline [&_h2]:mt-8 [&_h2]:text-[1.1rem] [&_p]:my-4 [&_p]:text-muted-foreground"
    >
      <Wordmark />
      <h1 className="mb-1 text-[2em]">{title}</h1>
      {children}
    </main>
  );
}
