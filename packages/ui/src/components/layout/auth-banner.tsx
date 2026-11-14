import { ShieldOff } from "lucide-react";
import { useConfig } from "@/lib/api/hooks";

export function AuthBanner() {
  const { data } = useConfig();
  if (!data || data.auth.enabled) return null;
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-4 py-1 text-xs text-amber-300"
    >
      <ShieldOff className="size-3.5" />
      Authentication disabled. Anyone who can reach this dashboard can see all traces.
    </div>
  );
}
