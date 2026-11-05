// @ts-check
// How you're signed in, your recovery code (for passkey and device keys
// alike), and locking Contri on this device.

import { forgetDeviceSecret, recoveryCode } from "../../lib/passkey.js";
import { busy, h, show } from "../ui.js";
import { refresh, state } from "../state.js";
import { confirmWithPasskey, lock, markRecoverySeen, mode, recoverySeen, secret } from "../wallet.js";

export async function settingsScreen() {
  const passkey = mode() === "passkey";
  // With a passkey, locking asks for it next time. With a key kept on this
  // device there's nothing to ask for, so the only real lock is removing the
  // key, after which the recovery code is the way back.
  const signOut = h("button", { class: "secondary" }, passkey ? "Lock Contri on this device" : "Remove my key from this device");
  const confirmRemove = h("div", { class: "callout stack", hidden: true },
    h("p", null, h("strong", null, "Have you written down your recovery code?")),
    h("p", null, "Without it you can't get back to your circles or your money after removing the key."),
    h("div", { class: "actions row" },
      h("button", { class: "secondary", onclick: () => (confirmRemove.hidden = true) }, "Keep it"),
      h("button", { class: "primary", onclick: () => leave() }, "Remove it"),
    ),
  );
  const leave = async () => {
    await lock();
    if (!passkey) forgetDeviceSecret();
    location.hash = "#/";
    location.reload();
  };
  signOut.addEventListener("click", () => (passkey ? leave() : (confirmRemove.hidden = false)));

  const code = h("p", { class: "code-block", translate: "no", hidden: true }, recoveryCode(secret()));
  const reveal = h("button", { class: "secondary" }, "Show my recovery code");
  reveal.addEventListener("click", () =>
    busy(reveal, code.hidden ? "Confirm with your passkey" : "Hiding", async () => {
      // The code opens everything, so showing it asks for the passkey again.
      if (code.hidden) await confirmWithPasskey();
      code.hidden = !code.hidden;
      if (!code.hidden) await markRecoverySeen();
    }).then(() => (reveal.textContent = code.hidden ? "Show my recovery code" : "Hide it")),
  );

  const seen = await recoverySeen().catch(() => false);
  // Circles this key is in: shown at once from the last refresh, or filled in
  // when a fresh look comes back, so the screen never waits on the network.
  /** @param {import("../state.js").Slot[]} slots */
  const count = (slots) => {
    const n = new Set(slots.flatMap((x) => x.circles)).size;
    return n ? `${n} circle${n === 1 ? "" : "s"}, one account each` : "Ready for your first circle";
  };
  const countTag = h("span", { class: "glass-tag tag-count" }, state.slots ? count(state.slots) : "Counting your circles");
  if (!state.slots) refresh().then((st) => (countTag.textContent = count(st.slots ?? [])), () => (countTag.textContent = "One account per circle"));

  show(
    h("div", { class: "key-page" },
      h("section", { class: "key-intro" },
        h("a", { class: "back", href: "#/" }, "Your circles"),
        h("div", { class: "key-heading" },
          h("h1", { class: "headline-sans" }, "Your key"),
          h("p", { class: "headline-serif" }, passkey ? "lives in your passkey." : "lives on this device."),
        ),
        h("p", null, passkey
          ? "Nobody else holds it, not even Contri. Every circle account, and your private balance, comes from it, on this phone, each time you open the app."
          : "It's kept in this browser, without a passkey. Every circle account, and your private balance, comes from it."),
      ),
      h("section", { class: "key-cards", "aria-label": "Your key at a glance" },
        h("article", { class: "kcard kcard-left", tabindex: "0", "aria-label": "One key" },
          h("div", { class: "left-surface", "aria-hidden": "true" }),
          keyIcon(),
          h("span", { class: "glass-tag tag-left" }, passkey ? "Passkey" : "This browser"),
          h("span", { class: "glass-tag tag-right" }, "No password"),
          h("span", { class: "glass-tag live" }, h("i", { class: "dot" }), h("span", null, "Unlocked here")),
          countTag,
          h("h2", { class: "kcard-title" }, "One key for ", h("strong", null, "every circle you're in.")),
        ),
        h("article", { class: "kcard kcard-middle", tabindex: "0", "aria-label": "Separate accounts" },
          eyeIcon(),
          h("span", { class: "kcard-site" }, "contri.ng"),
          h("div", { class: "orbit" }, h("i", { class: "orbit-dot" })),
          h("div", { class: "sphere" }),
          h("span", { class: "glass-tag t1" }, h("i", { class: "dot" }), "own account per circle"),
          h("span", { class: "glass-tag t2" }, h("i", { class: "dot" }), "no name on chain"),
          h("span", { class: "glass-tag t3" }, h("i", { class: "dot amber" }), "nothing links them"),
          h("p", { class: "kcard-copy" }, "Each circle gets its own account. Nobody looking at the blockchain can tell they're yours."),
        ),
        h("article", { class: "kcard kcard-right", tabindex: "0", "aria-label": "Recovery" },
          pulseIcon(),
          h("div", { class: "status-band", "aria-hidden": "true" }),
          h("div", { class: "status-stack" },
            h("div", { class: "kstatus" }, h("i", { class: "dot amber" }), h("span", null, "Recovery code"), h("em", null, seen ? "seen" : "not shown yet")),
            h("div", { class: "kstatus" }, h("i", { class: "dot" }), h("span", null, "Signed in"), h("em", null, passkey ? "passkey" : "this device")),
          ),
          h("h2", { class: "kcard-title big" }, "Yours."),
        ),
      ),
      h("section", { class: "stack narrow key-controls" },
        h("h2", null, "Your recovery code"),
        h("p", null,
          passkey
            ? "Write it down and keep it offline. If your passkey is ever deleted, this code brings back your circles and your money: open Contri, choose Other ways in, then Restore from a recovery code."
            : "It's the only way back if this phone is lost or the browser is cleared: open Contri, choose Other ways in, then Restore from a recovery code."),
        h("p", { class: "hint" }, "Anyone with this code can use your circles and move your money. Never share it, and Contri will never ask for it."),
        h("div", { class: "actions" }, reveal),
        code,
        h("h2", null, "This device"),
        passkey
          ? h("p", null, "Contri stays unlocked on this device until you lock it here, so switching apps, closing the browser or restarting doesn't ask for your passkey again. Your phone's screen lock is what protects it. Lock it if other people use this device.")
          : h("p", null, "Anyone who can use this browser can open Contri. If other people use this device, remove the key here, or sign in with a passkey instead."),
        h("div", { class: "actions" }, signOut),
        confirmRemove,
      ),
    ),
  );
}

const svg = (/** @type {string} */ viewBox, /** @type {string} */ cls, /** @type {string} */ d) => {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", viewBox);
  el.setAttribute("class", `kcard-icon ${cls}`);
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = d;
  return el;
};
const keyIcon = () => svg("0 0 32 32", "", '<circle cx="11" cy="16" r="6" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M17 16h11M24 16v5M28 16v4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>');
const eyeIcon = () => svg("0 0 34 26", "", '<path d="M2 13S7.8 4 17 4s15 9 15 9-5.8 9-15 9S2 13 2 13Z" fill="none" stroke="currentColor" stroke-width="2.1"/><circle cx="17" cy="13" r="4.2" fill="none" stroke="currentColor" stroke-width="2.1"/>');
const pulseIcon = () => svg("0 0 39 29", "pulse", '<path d="M1.5 16h8l4.2-11 7.1 23 5.4-17 3.1 5h8.2" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>');
