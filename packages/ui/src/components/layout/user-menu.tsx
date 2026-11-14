import { Link } from "react-router";
import { Bell, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAuth } from "@/lib/auth/provider";
import { settingsLink } from "@/lib/links/links";
import { useWorkspace } from "@/lib/links/use-scope";

export function UserMenu() {
  const { status, user } = useAuth();
  const workspace = useWorkspace();
  if (status !== "signed-in" || !user) return null;
  const label = user.email ?? user.name ?? user.sub;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="rounded-full" aria-label="Account">
          <span className="flex size-7 items-center justify-center rounded-full bg-secondary text-xs font-medium uppercase text-secondary-foreground">
            {label.slice(0, 1)}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-1">
        <div className="px-3 py-2">
          <div className="text-xs text-muted-foreground">Signed in as</div>
          <div className="truncate text-sm font-medium" title={label}>
            {label}
          </div>
        </div>
        <div className="my-1 border-t" />
        {workspace && (
          <Link
            to={settingsLink(workspace, "notifications")}
            className="flex items-center gap-2 rounded-sm px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <Bell className="size-4" />
            Notifications
          </Link>
        )}
        <Link
          to="/logout"
          className="flex items-center gap-2 rounded-sm px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <LogOut className="size-4" />
          Sign out
        </Link>
      </PopoverContent>
    </Popover>
  );
}
