import type { PlanEntry } from "../../src/types.ts";
import { dom, onSessionReset } from "./state.ts";
import { buildPlanElement } from "./plan-view.ts";

type PlanPanelAction = "show" | "hide" | "toggle";

let currentEntries: PlanEntry[] | null = null;
let dismissed = false;
let expanded = true;

function render(): void {
  dom.planPanel.replaceChildren();
  if (!currentEntries || dismissed) {
    dom.planPanel.hidden = true;
    dom.planPanel.open = false;
    return;
  }

  const content = buildPlanElement(currentEntries, {
    className: "plan-panel-content",
    open: true,
  });
  dom.planPanel.append(...content.childNodes);
  dom.planPanel.hidden = false;
  dom.planPanel.open = expanded;
}

export function updatePlanPanel(entries: PlanEntry[]): void {
  if (
    entries.length === 0 ||
    entries.every((entry) => entry.status === "completed")
  ) {
    clearPlanPanel();
    return;
  }

  if (!currentEntries) dismissed = false;
  currentEntries = entries;
  render();
}

export function clearPlanPanel(): void {
  currentEntries = null;
  dismissed = false;
  expanded = true;
  render();
}

export function controlPlanPanel(action: PlanPanelAction): boolean {
  if (!currentEntries) return false;
  if (action === "show") dismissed = false;
  else if (action === "hide") dismissed = true;
  else dismissed = !dismissed;
  render();
  return true;
}

dom.planPanel.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.closest(".plan-summary"))
    return;
  expanded = !dom.planPanel.open;
});

onSessionReset(clearPlanPanel);
