import type { IssueLabel } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { pickTextColorForPillBg } from "@/lib/color-contrast";
import { cn } from "../lib/utils";

type ChipLabel = Pick<IssueLabel, "id" | "name" | "color">;

/** A task label as a chip tinted with the label's own colour. */
export function IssueLabelChip({ label, className }: { label: ChipLabel; className?: string }) {
  return (
    <Badge variant="outline"
      className={cn("min-w-0 max-w-full px-1.5 py-0 text-(length:--text-nano)", className)}
      style={{
        borderColor: label.color,
        color: pickTextColorForPillBg(label.color, 0.12),
        backgroundColor: `${label.color}1f`,
      }}
    >
      <span className="truncate">{label.name}</span>
    </Badge>
  );
}

/** The first `max` labels as chips, then "+N" for the rest. Renders nothing without labels. */
export function IssueLabelChips({ labels, max, className }: { labels: readonly ChipLabel[]; max: number; className?: string }) {
  if (labels.length === 0) return null;
  return (
    <span className={cn("flex min-w-0 items-center gap-1 overflow-hidden", className)}>
      {labels.slice(0, max).map((label) => <IssueLabelChip key={label.id} label={label} />)}
      {labels.length > max ? (
        <span className="shrink-0 text-(length:--text-nano) font-medium text-muted-foreground">
          +{labels.length - max}
        </span>
      ) : null}
    </span>
  );
}
