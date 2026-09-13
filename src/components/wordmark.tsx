import { cn } from "@/lib/utils";

// The earcue wordmark: display serif with the accent dot.
export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center font-display text-[22px] tracking-[-0.01em] after:ml-1 after:inline-block after:size-1.5 after:rounded-full after:bg-brand after:content-['']",
        className
      )}
    >
      earcue
    </span>
  );
}
