import { dom, setInputValue } from "./state.ts";
import { openSlashMenuForPath } from "./commands.ts";

let installed = false;

export function installInboxIndicator(): void {
  if (installed) return;
  installed = true;
  dom.inboxBtn.addEventListener("click", () => {
    if (dom.input.value) {
      openSlashMenuForPath("/inbox ");
    } else {
      setInputValue("/inbox ");
    }
    dom.input.focus();
  });
}
