// @ts-check
// How you're signed in, your recovery code (for passkey and device keys
// alike), and locking Contri on this device.

import { recoveryCode } from "../../lib/passkey.js";
import { h, show } from "../ui.js";
import { lock, markRecoverySeen, mode, secret } from "../wallet.js";

export function settingsScreen() {
  const signOut = h("button", { class: "secondary" }, "Lock Contri on this device");
  signOut.addEventListener("click", async () => {
    await lock();
    location.hash = "#/";
    location.reload();
  });

  const code = h("p", { class: "code-block", translate: "no", hidden: true }, recoveryCode(secret()));
  const reveal = h("button", { class: "secondary" }, "Show my recovery code");
  reveal.addEventListener("click", () => {
    code.hidden = !code.hidden;
    reveal.textContent = code.hidden ? "Show my recovery code" : "Hide it";
    if (!code.hidden) markRecoverySeen();
  });

  show(
    h("section", { class: "stack narrow" },
      h("a", { class: "back", href: "#/" }, "Your circles"),
      h("h1", null, "Your key"),
      mode() === "passkey"
        ? h("p", null, "You sign in with a passkey. On a new phone, use the same passkey (synced by Google Password Manager or iCloud Keychain) and your circles come back.")
        : h("p", null, "Your key is kept in this browser."),
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
      h("p", null, "Contri stays unlocked on this device until you lock it here, so switching apps, closing the browser or restarting doesn't ask for your passkey again. Lock it if other people use this device."),
      h("div", { class: "actions" }, signOut),
    ),
  );
}
