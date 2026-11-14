import { Tooltipped } from "@/components/ui/tooltipped";
import { serviceIconUrl } from "@/lib/spans/icon-url";
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
  return (
    <Tooltipped title={label}>
      <span
        role="img"
        aria-label={label}
        className={cn(
          "inline-block shrink-0 bg-zinc-500 bg-cover bg-center",
          size === "mini" ? "size-4 rounded-sm" : "size-10 rounded-full",
          className,
        )}
        style={{ backgroundImage: `url("${serviceIconUrl(icon, size)}")` }}
      />
    </Tooltipped>
  );
}
