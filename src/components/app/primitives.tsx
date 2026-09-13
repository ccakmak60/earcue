import { cn } from "@/lib/utils";

// Small presentational pieces shared by the app views and the settings sheet.

export const chipClass =
  "inline-flex max-w-[22rem] items-center gap-2 overflow-hidden rounded-full border border-input px-3 py-1 text-xs text-ellipsis whitespace-nowrap text-muted-foreground";

export function Chip({ className, ...props }: React.ComponentProps<"button">) {
  return <button type="button" className={cn(chipClass, "cursor-pointer hover:bg-card hover:text-foreground", className)} {...props} />;
}

export function Chips({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("mt-3 flex flex-wrap gap-2", className)} {...props} />;
}

export function LiveDot({ live = false }: { live?: boolean }) {
  return <span className={cn("size-1.5 flex-none rounded-full bg-ink-tertiary", live && "animate-pulse bg-brand")} aria-hidden="true" />;
}

export function ViewSection({ active, labelledBy, children }: { active: boolean; labelledBy: string; children: React.ReactNode }) {
  return (
    <section hidden={!active} aria-labelledby={labelledBy} className="mx-auto flex w-full max-w-content flex-1 flex-col gap-6">
      {children}
    </section>
  );
}

export function ViewTitle({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <h1 id={id} className="font-display text-[34px] leading-[1.1]">
      {children}
    </h1>
  );
}

export function ActionBar({ children }: { children: React.ReactNode }) {
  return <div className="sticky bottom-0 mt-auto flex justify-center gap-2 border-t bg-background/88 p-3 backdrop-blur-[8px]">{children}</div>;
}

export function Note({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("text-xs text-muted-foreground", className)} {...props} />;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

export function Kicker({ as: Tag = "h4", className, children }: { as?: "h2" | "h3" | "h4"; className?: string; children: React.ReactNode }) {
  return <Tag className={cn("mb-2 text-xs font-medium tracking-[0.08em] text-ink-tertiary uppercase", className)}>{children}</Tag>;
}

export function Card({ wide = false, className, children }: { wide?: boolean; className?: string; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "rounded-lg border bg-card p-4 [&_p]:mb-2 [&_p]:text-sm [&_p]:leading-[1.6] [&_p]:whitespace-pre-wrap [&_p:last-child]:mb-0",
        wide && "col-span-full",
        className
      )}
    >
      {children}
    </div>
  );
}

export function CardGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">{children}</div>;
}

export function FieldLabel({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-1 block text-[13px] text-muted-foreground">
      {children}
    </label>
  );
}

export function FieldGroup({ className, ...props }: React.ComponentProps<"section">) {
  return <section className={cn("flex flex-col gap-3", className)} {...props} />;
}

export function Row({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="text-sm">{children}</div>
      {action}
    </div>
  );
}
