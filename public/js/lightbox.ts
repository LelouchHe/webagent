// Image lightbox — click chat images to view full-size with zoom

const overlay = document.createElement("div");
overlay.id = "lightbox-overlay";
const img = document.createElement("img");
overlay.appendChild(img);
document.body.appendChild(overlay);

let scale = 1;
const MIN_SCALE = 0.5;
const MAX_SCALE = 5;

function isOpen() {
  return overlay.classList.contains("active");
}

function open(src: string) {
  img.src = src;
  scale = 1;
  img.style.transform = "";
  overlay.classList.add("active");
}

function close() {
  overlay.classList.remove("active");
  img.src = "";
}

// Chat images that open the lightbox: a user's attachment, an image an agent
// returned inline, and a thumbnail of a tool result image. One delegate, one
// open() — the payload differs (a signed URL vs. a data URL), the interaction
// does not.
const CLICKABLE_IMAGE_CLASSES = ["user-image", "agent-image", "tc-image"];

// Event delegation — any clickable chat image inside #messages
document.getElementById("messages")!.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (
    target.tagName === "IMG" &&
    CLICKABLE_IMAGE_CLASSES.some((cls) => target.classList.contains(cls))
  ) {
    open((target as HTMLImageElement).src);
  }
});

// Click backdrop to close (but not when clicking the image itself)
overlay.addEventListener("click", (e) => {
  if (e.target === overlay) close();
});

// Escape to close
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && isOpen()) {
    close();
  }
});

// Wheel zoom
overlay.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.15 : 0.15;
    scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale + delta));
    img.style.transform = `scale(${scale})`;
  },
  { passive: false },
);
