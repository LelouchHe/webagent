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
} from "./file-browser.ts";
import { openFileInfo } from "./file-viewer.ts";

export interface FileBrowserItem {
  name: string;
  path: string;
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

/** Cache partition for the query-aware slash fetch contract. */
export function viewFetchKey(query: string): string {
  const directory = resolveBrowseTarget(query, state.sessionCwd).directory;
  if (directory === "/") return directory;
  return directory.replace(/\/+$/, "");
}

export async function fetchViewItems(
  query: string,
): Promise<FileBrowserItem[]> {
  const target = resolveBrowseTarget(query, state.sessionCwd);
  const result = await api.listFiles(target.directory);
  const items: FileBrowserItem[] = [];
  if (result.parent !== result.path) {
    items.push({
      name: "..",
      path: result.parent,
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
    });
  }
  return items;
}

export function viewItemMatches(item: unknown, query: string): boolean {
  const row = item as FileBrowserItem;
  const filter = fileFilter(query);
  if (!filter) return true;
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
      fill: directoryInput(row.path).slice("/view ".length),
      onSelect: () => {
        enterViewDirectory(row.path);
      },
    };
  }
  return {
    primary: row.name,
    secondary: formatSize(row.size),
    fill: row.path,
    onSelect: () => openViewPath(row.path),
  };
}

/** Enter dispatch: directory → drill down; file → responsive viewer. */
export async function openViewPath(query: string): Promise<void> {
  try {
    const path = resolveViewPath(query, state.sessionCwd);
    const info = await api.getFileInfo(path);
    if (info.kind === "dir") {
      enterViewDirectory(info.path);
      return;
    }
    await openFileInfo(info);
  } catch (err) {
    addSystem(
      `view: ${err instanceof Error ? err.message : "Unable to open path"}`,
    );
  }
}
