import type { PlanEntry } from "../../src/types.ts";
import {
  formatPlanEntries,
  formatPlanStatusCounts,
} from "./event-interpreter.ts";

export function buildPlanElement(
  entries: PlanEntry[],
  options: { className: string; open: boolean },
): HTMLDetailsElement {
  const planViews = formatPlanEntries(entries);
  const countViews = formatPlanStatusCounts(entries);
  const el = document.createElement("details");
  el.className = options.className;
  el.open = options.open;

  const summary = document.createElement("summary");
  summary.className = "plan-summary";
  const statusLabel = countViews
    .map((view) => `${view.count} ${view.label}`)
    .join(", ");
  summary.setAttribute(
    "aria-label",
    statusLabel ? `plan: ${statusLabel}` : "plan",
  );

  const label = document.createElement("span");
  label.className = "plan-label";
  label.textContent = "plan";
  summary.appendChild(label);

  const counts = document.createElement("span");
  counts.className = "plan-counts";
  for (const [index, view] of countViews.entries()) {
    if (index > 0) counts.appendChild(document.createTextNode("  "));
    const count = document.createElement("span");
    count.className = `plan-status-${view.status}`;
    count.textContent = `${view.symbol} ${view.count}`;
    counts.appendChild(count);
  }
  summary.appendChild(counts);
  el.appendChild(summary);

  const rows = document.createElement("div");
  rows.className = "plan-entries";
  for (const view of planViews) {
    const row = document.createElement("div");
    row.className = `plan-entry plan-status-${view.status}`;

    const symbol = document.createElement("span");
    symbol.className = "plan-symbol";
    symbol.textContent = view.symbol;
    row.appendChild(symbol);
    row.appendChild(document.createTextNode(" "));

    const content = document.createElement("span");
    content.className = "plan-content";
    content.textContent = view.content;
    row.appendChild(content);
    rows.appendChild(row);
  }
  el.appendChild(rows);
  return el;
}
