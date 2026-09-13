"use client";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import * as localstore from "@/lib/client/localstore";
import { FieldGroup, FieldLabel, Kicker } from "./primitives";

// Values are shown live in the All day chips and persisted when the field is committed (blur).
export function SettingsAmbient({
  retentionDays,
  blocklist,
  onRetentionDays,
  onBlocklist,
}: {
  retentionDays: string;
  blocklist: string;
  onRetentionDays: (value: string) => void;
  onBlocklist: (value: string) => void;
}) {
  return (
    <FieldGroup>
      <Kicker as="h3" className="mb-0">
        All day
      </Kicker>
      <div>
        <FieldLabel htmlFor="retentionDays">Keep unsent audio for (days)</FieldLabel>
        <Input
          type="number"
          id="retentionDays"
          min={1}
          max={14}
          value={retentionDays}
          onChange={(e) => onRetentionDays(e.target.value)}
          onBlur={(e) => localstore.setRetentionDays(Number(e.target.value) || 3)}
        />
      </div>
      <div>
        <FieldLabel htmlFor="blocklist">Blocklist (one per line)</FieldLabel>
        <Textarea
          id="blocklist"
          placeholder={"banking\n1password"}
          value={blocklist}
          onChange={(e) => onBlocklist(e.target.value)}
          onBlur={(e) =>
            localstore.setBlocklist(
              e.target.value
                .split("\n")
                .map((s) => s.trim().toLowerCase())
                .filter(Boolean)
            )
          }
        />
      </div>
    </FieldGroup>
  );
}
