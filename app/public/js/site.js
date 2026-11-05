// @ts-check
// The site's pages (not the app). The FAQ opens one answer at a time: browsers
// do that themselves for <details name="faq">; this does it for older ones.

if (!("name" in HTMLDetailsElement.prototype)) {
  for (const d of document.querySelectorAll("details[name]")) {
    d.addEventListener("toggle", () => {
      if (!(d instanceof HTMLDetailsElement) || !d.open) return;
      for (const other of document.querySelectorAll(`details[name="${d.getAttribute("name")}"]`)) {
        if (other !== d && other instanceof HTMLDetailsElement) other.open = false;
      }
    });
  }
}
