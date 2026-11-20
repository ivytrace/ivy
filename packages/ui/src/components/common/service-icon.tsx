import { Tooltipped } from "@/components/ui/tooltipped";
import { serviceIconUrl } from "@/lib/spans/icon-url";
import type { ScopeTint, ServiceIcon as Icon } from "@/lib/spans/services";
import { TINT_CLASSES } from "@/lib/spans/tint";
import { cn } from "@/lib/utils/cn";

export function ServiceIcon({
  icon,
  tint,
  label,
  size = "mini",
  className,
}: {
  icon: Icon;
  tint?: ScopeTint;
  label: string;
  size?: "mini" | "large";
  className?: string;
}) {
  return (
    <Tooltipped title={label}>
      <span
        role="img"
        aria-label={label}
        className={cn(
          "inline-block shrink-0 bg-zinc-500 bg-cover bg-center",
          size === "mini" ? "size-4 rounded-sm" : "size-10 rounded-full",
          tint && TINT_CLASSES[tint].icon,
          className,
        )}
        style={{ backgroundImage: `url("${serviceIconUrl(icon, size)}")` }}
      />
    </Tooltipped>
  );
}
