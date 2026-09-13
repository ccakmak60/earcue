import { cn } from "@/lib/utils";

// A product screenshot stand-in: a card with window-chrome dots.
export function Mock({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("rounded-lg border bg-card p-4 shadow-ec-md", className)}>
      <div className="mb-4 flex gap-1.5" aria-hidden="true">
        <span className="size-2 rounded-full bg-input" />
        <span className="size-2 rounded-full bg-input" />
        <span className="size-2 rounded-full bg-input" />
      </div>
      {children}
    </div>
  );
}

export function Eyebrow({ children }: { children: React.ReactNode }) {
  return <div className="text-xs font-medium tracking-[0.08em] text-ink-tertiary uppercase">{children}</div>;
}

export function FeatureRow({
  eyebrow,
  title,
  body,
  reverse = false,
  children,
}: {
  eyebrow: string;
  title: string;
  body: React.ReactNode;
  reverse?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="grid items-center gap-14 [&+&]:mt-24 min-[901px]:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <div className={cn(reverse && "min-[901px]:order-2")}>
        <Eyebrow>{eyebrow}</Eyebrow>
        <h3 className="mt-3 font-display text-[32px] leading-[1.05] tracking-[-0.02em]">{title}</h3>
        <p className="mt-4 max-w-[34rem] text-sm leading-relaxed text-muted-foreground">{body}</p>
      </div>
      <div className={cn(reverse && "min-[901px]:order-1")}>{children}</div>
    </div>
  );
}
