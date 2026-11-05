// @ts-check
// How you're signed in, your recovery code (for passkey and device keys
// alike), and locking Contri on this device.

import { forgetDeviceSecret, recoveryCode } from "../../lib/passkey.js";
import { busy, h, show } from "../ui.js";
import { confirmWithPasskey, lock, markRecoverySeen, mode, secret } from "../wallet.js";

export function settingsScreen() {
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

  show(
    h("section", { class: "stack narrow" },
      h("a", { class: "back", href: "#/" }, "Your circles"),
      h("h1", null, "Your key"),
      passkey
        ? h("p", null, "You sign in with a passkey. On a new phone, use the same passkey (synced by Google Password Manager or iCloud Keychain) and your circles come back.")
        : h("p", null, "Your key is kept in this browser, without a passkey. Anyone who can use this browser can open Contri. If other people use this device, remove the key here, or sign in with a passkey instead."),
      h("h2", null, "Your recovery code"),
      h("p", null,
        mode() === "passkey"
          ? "Write it down and keep it offline. If your passkey is ever deleted, this code brings back your circles and your money: open Contri, choose Other ways in, then Restore from a recovery code."
          : "It's the only way back if this phone is lost or the browser is cleared: open Contri, choose Other ways in, then Restore from a recovery code."),
      h("p", { class: "hint" }, "Anyone with this code can use your circles and move your money. Never share it, and Contri will never ask for it."),
      h("div", { class: "actions" }, reveal),
      code,
      h("h2", null, "This device"),
      h("p", null, "Every circle you're in uses its own account, made from your key. Nobody looking at the blockchain can tell they belong to the same person."),
      passkey
        ? h("p", null, "Contri stays unlocked on this device until you lock it here, so switching apps, closing the browser or restarting doesn't ask for your passkey again. Your phone's screen lock is what protects it. Lock it if other people use this device.")
        : null,
      h("div", { class: "actions" }, signOut),
      confirmRemove,
    ),
  );
}
