// `/view` slash command integration: directory-scoped fetching, local final-
// segment filtering, folder drill-down, and file handoff to file-viewer.ts.

import * as api from "./api.ts";
import { state, dom, setInputValue } from "./state.ts";
import { addSystem } from "./render.ts";
import type { SlashItemSpec } from "./slash-render.ts";
import {
  fileFilter,
  joinListedPath,
  resolveBrowseTarget,
  resolveViewPath,
  wantsHidden,
} from "./file-browser.ts";
import { openFileInfo } from "./file-viewer.ts";

export interface FileBrowserItem {
  name: string;
  /** Canonical path for identity/debugging; not written into the input UI. */
  path: string;
  /** Home-abbreviated path used by Tab, clicks, and the viewer header. */
  pathDisplay: string;
  kind: "file" | "dir";
  size: number | null;
  mtime: number;
  parent?: boolean;
}

function directoryInput(path: string): string {
  return path === "/" ? "/view /" : `/view ${path.replace(/\/+$/, "")}/`;
}

export function enterViewDirectory(path: string): void {
  setInputValue(directoryInput(path));
  dom.input.focus();
}

/** Cache partition for the query-aware slash fetch contract. Hidden entries
 *  are a second listing of the same directory, so the flag partitions the
 *  fetch cache instead of waiting for the directory itself to change. */
export function viewFetchKey(query: string): string {
  const target = resolveBrowseTarget(query, state.taskCwd);
  const directory =
    target.directory === "/"
      ? target.directory
      : target.directory.replace(/\/+$/, "");
  return wantsHidden(target.filter) ? `${directory}\u0000hidden` : directory;
}

export async function fetchViewItems(
  query: string,
): Promise<FileBrowserItem[]> {
  const target = resolveBrowseTarget(query, state.taskCwd);
  const result = await api.listFiles(target.directory, {
    includeHidden: wantsHidden(target.filter),
  });
  const items: FileBrowserItem[] = [];
  if (result.parent !== result.path) {
    items.push({
      name: "..",
      path: result.parent,
      pathDisplay: result.parentDisplay ?? result.parent,
      kind: "dir",
      size: null,
      mtime: 0,
      parent: true,
    });
  }
  for (const entry of result.entries) {
    items.push({
      ...entry,
      path: joinListedPath(result.path, entry.name),
      pathDisplay: joinListedPath(
        result.pathDisplay ?? result.path,
        entry.name,
      ),
    });
  }
  return items;
}

export function viewItemMatches(item: unknown, query: string): boolean {
  const row = item as FileBrowserItem;
  const filter = fileFilter(query);
  if (!filter) return true;
  // A dot filter addresses hidden entries only, with prefix semantics: they
  // are the entries a plain listing never showed, and `includes` would let
  // `README.md` answer a `.` filter. `..` is not a dotfile.
  if (wantsHidden(filter)) {
    return !row.parent && row.name.toLowerCase().startsWith(filter);
  }
  if (row.parent) return "..".includes(filter);
  return row.name.toLowerCase().includes(filter);
}

function formatSize(size: number | null): string | undefined {
  if (size === null) return undefined;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

export function viewItemSpec(item: unknown): SlashItemSpec {
  const row = item as FileBrowserItem;
  if (row.kind === "dir") {
    const display = row.parent ? ".." : `${row.name}/`;
    return {
      primary: display,
      secondary: row.parent ? "parent" : "folder",
      fill: directoryInput(row.pathDisplay).slice("/view ".length),
      continueOnFill: true,
      onSelect: () => {
        enterViewDirectory(row.pathDisplay);
      },
    };
  }
  return {
    primary: row.name,
    secondary: formatSize(row.size),
    fill: row.pathDisplay,
    onSelect: () => openViewPath(row.pathDisplay),
  };
}

/** Enter dispatch: directory → drill down; file → responsive viewer. */
export async function openViewPath(query: string): Promise<void> {
  try {
    const path = resolveViewPath(query, state.taskCwd);
    const info = await api.getFileInfo(path);
    if (info.kind === "dir") {
      enterViewDirectory(info.pathDisplay ?? info.path);
      return;
    }
    await openFileInfo(info);
  } catch (err) {
    addSystem(
      `view: ${err instanceof Error ? err.message : "Unable to open path"}`,
    );
  }
}
