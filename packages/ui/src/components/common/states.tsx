import type { ReactNode } from "react";
import { AlertTriangle, Inbox, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils/cn";

export function LoadingState({ label = "Loading…", className }: { label?: string; className?: string }) {
  return (
    <div className={cn("flex items-center justify-center gap-2 p-10 text-sm text-muted-foreground", className)}>
      <Loader2 className="size-4 animate-spin" />
      {label}
    </div>
  );
}

export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 p-10 text-center text-sm", className)}>
      <AlertTriangle className="size-6 text-red-400" />
      <div>
        <div className="font-medium">Couldn't load data</div>
        <div className="mt-1 text-muted-foreground">{message}</div>
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 p-10 text-center text-sm", className)}>
      <Inbox className="size-6 text-muted-foreground" />
      <div>
        <div className="font-medium">{title}</div>
        {description && <div className="mt-1 text-muted-foreground">{description}</div>}
      </div>
      {children}
    </div>
  );
}
