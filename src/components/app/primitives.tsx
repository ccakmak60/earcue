"use client";

import { useState } from "react";
import { Loader2Icon } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Small presentational pieces shared by the app views and the settings sheet.

export const chipClass =
  "inline-flex max-w-[22rem] items-center gap-2 overflow-hidden rounded-full border border-input px-3 py-1 text-xs text-ellipsis whitespace-nowrap text-muted-foreground transition-[background-color,border-color,color,scale] duration-150 ease-out";

export function Chip({ className, ...props }: React.ComponentProps<"button">) {
  return <button type="button" className={cn(chipClass, "cursor-pointer hover:bg-card hover:text-foreground active:scale-[0.98]", className)} {...props} />;
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
  return <div className="sticky bottom-0 z-40 mt-auto flex flex-wrap justify-center gap-2 border-t bg-background/88 p-3 backdrop-blur-[8px] max-[820px]:bottom-[var(--ec-nav-h)]">{children}</div>;
}

export function Note({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("text-xs text-muted-foreground", className)} {...props} />;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

export function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return <div aria-hidden="true" className={cn("animate-pulse rounded-sm bg-muted", className)} {...props} />;
}

export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-10 text-center">
      <Icon className="size-5 text-ink-tertiary" />
      <p className="text-sm">{title}</p>
      {hint && <p className="max-w-[28rem] text-xs text-muted-foreground">{hint}</p>}
      {action}
    </div>
  );
}

export function Kicker({ as: Tag = "h4", className, children }: { as?: "h2" | "h3" | "h4"; className?: string; children: React.ReactNode }) {
  return <Tag className={cn("mb-2 text-xs font-medium tracking-[0.08em] text-ink-tertiary uppercase", className)}>{children}</Tag>;
}

export function Card({ wide = false, className, style, children }: { wide?: boolean; className?: string; style?: React.CSSProperties; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "rounded-lg border bg-card p-4 shadow-ec-sm [&_p]:mb-2 [&_p]:text-sm [&_p]:leading-[1.6] [&_p]:whitespace-pre-wrap [&_p:last-child]:mb-0",
        wide && "col-span-full",
        className
      )}
      style={style}
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

// A lucide icon on a sunken square: the one way a source or recommendation kind is marked.
export function IconTile({ icon: Icon, className }: { icon: React.ComponentType<{ className?: string }>; className?: string }) {
  return (
    <span aria-hidden="true" className={cn("grid size-9 flex-none place-items-center rounded-sm bg-muted text-foreground", className)}>
      <Icon className="size-4" />
    </span>
  );
}

// Progress or outcome of a long action. The spinner shows only while busy; the text is announced.
export function StatusLine({ busy, children, className }: { busy: boolean; children: React.ReactNode; className?: string }) {
  return (
    <p role="status" aria-live="polite" className={cn("flex min-h-5 items-center gap-2 text-sm text-muted-foreground", className)}>
      {busy && <Loader2Icon className="size-4 flex-none animate-spin" aria-hidden="true" />}
      <span className="min-w-0">{children}</span>
    </p>
  );
}

// A destructive action behind a confirmation dialog, for removals that also delete learned memories.
export function ConfirmButton({
  label,
  title,
  description,
  confirmLabel,
  onConfirm,
  variant = "ghost",
  size = "sm",
}: {
  label: string;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => Promise<unknown>;
  variant?: "ghost" | "outline";
  size?: "sm" | "default";
}) {
  const [busy, setBusy] = useState(false);
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant={variant} size={size} disabled={busy}>
          {busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
              } catch (err) {
                console.error(`${label} failed`, err);
              }
              setBusy(false);
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
