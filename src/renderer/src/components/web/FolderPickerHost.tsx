import { useCallback, useEffect, useState } from "react";
import { ChevronUp, Folder } from "lucide-react";
import { parseDirListing, registerFolderPicker, type DirListing } from "@/lib/webUi";

type PendingPick = { resolve: (value: string | null) => void; start?: string };

export function FolderPickerHost() {
  const [pending, setPending] = useState<PendingPick | null>(null);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () =>
      registerFolderPicker(
        (start) => new Promise<string | null>((resolve) => {
          setPending((previous) => {
            previous?.resolve(null);
            return { resolve, start };
          });
        }),
      ),
    [],
  );

  const load = useCallback(async (path?: string): Promise<void> => {
    setError(null);
    const query = path ? `?path=${encodeURIComponent(path)}` : "";
    try {
      const response = await fetch(`/api/fs/dirs${query}`, { credentials: "same-origin" });
      const parsed = parseDirListing(await response.json().catch(() => null));
      if (parsed) return setListing(parsed);
      if (path) return load();
      setError("Couldn't open that folder.");
    } catch {
      if (path) return load();
      setError("Couldn't open that folder.");
    }
  }, []);

  useEffect(() => {
    if (pending) void load(pending.start);
  }, [pending, load]);

  if (!pending) return null;

  const finish = (value: string | null): void => {
    pending.resolve(value);
    setPending(null);
    setListing(null);
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-background/60">
      <div className="flex max-h-[80vh] w-[min(28rem,92vw)] flex-col rounded-lg border border-border bg-card shadow-lg">
        <div className="border-b border-border px-4 py-3">
          <p className="text-sm font-medium text-foreground">Choose a folder on your Mac</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{listing?.path ?? "Loading…"}</p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {listing?.parent && (
            <button
              type="button"
              onClick={() => void load(listing.parent ?? undefined)}
              className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted"
            >
              <ChevronUp className="h-3.5 w-3.5" /> Up
            </button>
          )}
          {listing?.dirs.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => void load(`${listing.path}/${name}`)}
              className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground hover:bg-muted"
            >
              <Folder className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="truncate">{name}</span>
            </button>
          ))}
          {listing && listing.dirs.length === 0 && (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">No folders here.</p>
          )}
          {error && <p className="px-2 py-1.5 text-xs text-destructive">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={() => finish(null)}
            className="cursor-pointer rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!listing}
            onClick={() => listing && finish(listing.path)}
            className="cursor-pointer rounded-md bg-foreground px-3 py-1.5 text-xs font-semibold text-card hover:opacity-90 disabled:opacity-50"
          >
            Choose this folder
          </button>
        </div>
      </div>
    </div>
  );
}
