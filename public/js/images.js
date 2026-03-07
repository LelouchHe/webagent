// Image attach, preview, and paste handling

import { state, dom } from './state.js';

function readFileAsBase64(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(',')[1];
      resolve({ data: base64, mimeType: file.type, previewUrl: reader.result });
    };
    reader.readAsDataURL(file);
  });
}

function addPendingImage(img) {
  state.pendingImages.push(img);
  renderAttachPreview();
  dom.input.focus();
}

export function renderAttachPreview() {
  dom.attachPreview.innerHTML = '';
  if (state.pendingImages.length === 0) {
    dom.attachPreview.classList.remove('active');
    return;
  }
  dom.attachPreview.classList.add('active');
  state.pendingImages.forEach((img, i) => {
    const thumb = document.createElement('span');
    thumb.className = 'attach-thumb';
    thumb.innerHTML = `<img src="${img.previewUrl}"><button class="remove">×</button>`;
    thumb.querySelector('.remove').onclick = () => {
      state.pendingImages.splice(i, 1);
      renderAttachPreview();
    };
    dom.attachPreview.appendChild(thumb);
  });
}

// --- Event listeners ---

dom.attachBtn.onclick = () => dom.fileInput.click();
dom.fileInput.onchange = async () => {
  for (const f of dom.fileInput.files) {
    if (f.type.startsWith('image/')) addPendingImage(await readFileAsBase64(f));
  }
  dom.fileInput.value = '';
};

dom.input.addEventListener('paste', async (e) => {
  for (const item of e.clipboardData.items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      addPendingImage(await readFileAsBase64(item.getAsFile()));
    }
  }
});
