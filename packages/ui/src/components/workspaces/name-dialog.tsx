import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * A name in a dialog (create a workspace or project, or rename one). Slugs are made by the server
 * from the name and never change on rename; see `UrlSetting` for changing one deliberately.
 */
export function NameDialog({
  open,
  onOpenChange,
  title,
  description,
  submitLabel,
  initialName,
  placeholder,
  onSubmit,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  submitLabel: string;
  initialName?: string;
  placeholder?: string;
  onSubmit: (name: string) => Promise<void>;
  /** Extra content under the field (e.g. the URL setting when renaming). */
  children?: ReactNode;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(initialName ?? "");
    setError(null);
    // Reset only when the dialog opens.
  }, [open]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name.trim());
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="name-dialog">Name</Label>
            <Input id="name-dialog" value={name} autoFocus placeholder={placeholder} onChange={(e) => setName(e.target.value)} />
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
        {children}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The read-only URL of a workspace or project, with "Change URL" tucked under Advanced. Changing it
 * breaks existing links, so it's a deliberate action rather than part of renaming.
 */
export function UrlSetting({
  prefix,
  slug,
  disabled,
  disabledReason,
  onChange,
}: {
  /** Everything before the slug, e.g. `/w/acme/`. */
  prefix: string;
  slug: string;
  disabled?: boolean;
  disabledReason?: string;
  onChange: (slug: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(slug);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setValue(slug), [slug]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onChange(value.trim());
      setEditing(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-2">
      <div className="text-sm">
        <span className="text-muted-foreground">URL </span>
        <span className="font-mono">
          {prefix}
          {slug}
        </span>
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-xs text-muted-foreground">Advanced</summary>
        <div className="mt-2 grid gap-2">
          {disabled ? (
            <p className="text-xs text-muted-foreground">{disabledReason}</p>
          ) : editing ? (
            <form onSubmit={(e) => void save(e)} className="grid gap-2">
              <div className="flex items-center gap-1">
                <span className="shrink-0 whitespace-nowrap font-mono text-sm text-muted-foreground">{prefix}</span>
                <Input value={value} onChange={(e) => setValue(e.target.value)} className="h-8 font-mono" aria-label="URL slug" autoFocus />
              </div>
              <p className="text-xs text-muted-foreground">Lower-case letters, digits and dashes. Links and bookmarks with the old URL stop working.</p>
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={busy || !value.trim() || value.trim() === slug}>
                  {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
                  Save URL
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => (setEditing(false), setValue(slug))}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <div>
              <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
                Change URL
              </Button>
            </div>
          )}
          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>
      </details>
    </div>
  );
}
