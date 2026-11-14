import { Tooltipped } from "@/components/ui/tooltipped";
import type { ServiceIcon as Icon } from "@/lib/spans/services";
import { cn } from "@/lib/utils/cn";

export function ServiceIcon({
  icon,
  label,
  size = "mini",
  className,
}: {
  icon: Icon;
  label: string;
  size?: "mini" | "large";
  className?: string;
}) {
  const folder = size === "mini" ? "service-icons-mini" : "service-icons";
  return (
    <Tooltipped title={label}>
      <span
        role="img"
        aria-label={label}
        className={cn(
          "inline-block shrink-0 bg-slate-500 bg-cover bg-center",
          size === "mini" ? "size-4 rounded-sm" : "size-10 rounded-full",
          className,
        )}
        style={{ backgroundImage: `url(/images/${folder}/${icon}.svg)` }}
      />
    </Tooltipped>
  );
}
