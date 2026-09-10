// Attachment attach, preview, and paste handling.
//
// Handles both image and non-image file attachments. Images get an
// inline preview thumbnail; other files render as a text chip with
// name + remove button.

import { state, dom, type PendingAttachment } from "./state.ts";

function readImageAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(reader.result as string);
    };
    reader.readAsDataURL(file);
  });
}

async function makeAttachment(file: File): Promise<PendingAttachment> {
  const isImage = file.type.startsWith("image/");
  const base: PendingAttachment = {
    kind: isImage ? "image" : "file",
    file,
    mimeType: file.type || "application/octet-stream",
    name: file.name || (isImage ? "image" : "file"),
  };
  if (isImage) base.previewUrl = await readImageAsDataUrl(file);
  return base;
}

function addPendingAttachment(att: PendingAttachment) {
  state.pendingAttachments.push(att);
  renderAttachPreview();
}

// Shared by the non-image branch and the thumbnail decode-failure fallback.
function appendFileChip(thumb: HTMLElement, name: string): void {
  thumb.classList.add("attach-file");
  const nameEl = document.createElement("span");
  nameEl.className = "attach-file-name";
  nameEl.textContent = name;
  thumb.appendChild(nameEl);
}

export function renderAttachPreview() {
  dom.attachPreview.innerHTML = "";
  if (state.pendingAttachments.length === 0) {
    dom.attachPreview.classList.remove("active");
    return;
  }
  dom.attachPreview.classList.add("active");
  state.pendingAttachments.forEach((att, i) => {
    const thumb = document.createElement("span");
    thumb.className = "attach-thumb";
    if (att.kind === "image" && att.previewUrl) {
      const imgEl = document.createElement("img");
      // Thumbnail vs. file chip is decided by this browser's own decode
      // attempt, not a shared mime allow-list: iOS/macOS Safari decode HEIC
      // natively while desktop Chrome/Firefox do not, so a hardcoded list
      // would regress the platform that can decode. See docs/uploads.md.
      let swapped = false;
      const fallbackToFileChip = () => {
        if (swapped) return;
        swapped = true;
        imgEl.remove();
        appendFileChip(thumb, att.name);
      };
      imgEl.addEventListener("error", fallbackToFileChip);
      imgEl.addEventListener("load", () => {
        // Preview that "loads" with no intrinsic size is undecodable too.
        if (imgEl.naturalWidth === 0) fallbackToFileChip();
      });
      imgEl.src = att.previewUrl;
      thumb.appendChild(imgEl);
    } else {
      appendFileChip(thumb, att.name);
    }
    const removeBtn = document.createElement("button");
    removeBtn.className = "remove";
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", () => {
      state.pendingAttachments.splice(i, 1);
      renderAttachPreview();
    });
    thumb.appendChild(removeBtn);
    dom.attachPreview.appendChild(thumb);
  });
}

// Event listeners
//
// The attach button's onclick is wired by the input-actions registry
// (see input.ts → registerInputHandlers); we only own the file-input here.
dom.fileInput.onchange = async () => {
  for (const f of dom.fileInput.files!) {
    addPendingAttachment(await makeAttachment(f));
  }
  dom.fileInput.value = "";
};

dom.input.addEventListener("paste", (e: ClipboardEvent) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      e.preventDefault();
      void (async () => {
        const file = item.getAsFile();
        if (file) addPendingAttachment(await makeAttachment(file));
      })();
    }
  }
});
