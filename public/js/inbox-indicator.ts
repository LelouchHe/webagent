import { dom, setInputValue } from "./state.ts";

let installed = false;

export function installInboxIndicator(): void {
  if (installed) return;
  installed = true;
  dom.inboxBtn.addEventListener("click", () => {
    setInputValue("/inbox ");
    dom.input.focus();
  });
}
