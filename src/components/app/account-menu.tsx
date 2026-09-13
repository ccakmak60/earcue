"use client";

import { ChevronDown } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { authClient } from "@/lib/client/auth-client";

async function signOut() {
  try {
    await authClient.signOut();
  } finally {
    location.replace("/signin");
  }
}

export function AccountMenu({ email }: { email: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="flex w-full cursor-pointer items-center gap-2 rounded-sm p-2 text-sm hover:bg-accent">
          <Avatar className="size-[22px]" aria-hidden="true">
            <AvatarFallback className="bg-brand-soft text-[11px] font-semibold text-brand">{(email[0] || "?").toUpperCase()}</AvatarFallback>
          </Avatar>
          <span className="min-w-0 flex-1 truncate text-left">{email}</span>
          <ChevronDown className="size-3 text-muted-foreground" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width)">
        <DropdownMenuItem asChild>
          <a href="/account">Account &amp; billing</a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href="/privacy">Privacy</a>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={signOut}>Sign out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
