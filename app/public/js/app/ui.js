// @ts-check
// A tiny DOM toolkit: build elements, swap the screen, show notices.
// No framework and no inline scripts or styles, so the page can run under a
// strict Content Security Policy.

/** @typedef {Node | string | number | null | undefined | false} Child */

/**
 * h("button", { class: "primary", onclick }, "Pay")
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {Record<string, any> | null} [props]
 * @param {...(Child | Child[])} children
 * @returns {HTMLElementTagNameMap[K]}
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k in el && typeof v !== "string") /** @type {any} */ (el)[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, children);
  return el;
}

/** @param {Element} el @param {(Child | Child[])[]} children */
function append(el, children) {
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** Replaces the main view and moves focus to its heading, for screen readers and keyboards. @param {Node} view */
export function show(view) {
  const main = /** @type {HTMLElement} */ (document.getElementById("view"));
  main.replaceChildren(view);
  const heading = main.querySelector("h1");
  if (heading) {
    heading.setAttribute("tabindex", "-1");
    heading.focus({ preventScroll: true });
  }
  window.scrollTo(0, 0);
}

/** A short notice at the bottom of the screen. @param {string} text @param {"ok" | "error"} [kind] */
export function notice(text, kind = "ok") {
  const region = /** @type {HTMLElement} */ (document.getElementById("notices"));
  const el = h("p", { class: `notice ${kind}`, role: kind === "error" ? "alert" : "status" }, text);
  region.replaceChildren(el);
  setTimeout(() => el.remove(), kind === "error" ? 9000 : 4500);
}

/**
 * Runs an action from a button: disables it and shows progress, then reports
 * the error in the interface's words if it fails.
 * @param {HTMLButtonElement} button @param {string} busyText @param {() => Promise<void>} fn
 */
export async function busy(button, busyText, fn) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = busyText;
  button.setAttribute("aria-busy", "true");
  try {
    await fn();
  } catch (e) {
    notice(e instanceof Error ? e.message : String(e), "error");
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = label;
      button.removeAttribute("aria-busy");
    }
  }
}

/** A labelled form field. @param {string} label @param {HTMLElement} input @param {string} [hint] */
export function field(label, input, hint) {
  const id = input.id || `f-${Math.random().toString(36).slice(2, 8)}`;
  input.id = id;
  const hintEl = hint ? h("p", { class: "hint", id: `${id}-hint` }, hint) : null;
  if (hintEl) input.setAttribute("aria-describedby", hintEl.id);
  return h("div", { class: "field" }, h("label", { for: id }, label), input, hintEl);
}

/** Copies text and confirms it. @param {string} text @param {string} [what] */
export async function copy(text, what = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    notice(what);
  } catch {
    notice("Couldn't copy. Press and hold to select it instead.", "error");
  }
}

/** @param {number} ms */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
