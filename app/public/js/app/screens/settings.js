// @ts-check
// How you're signed in, your recovery code, and signing out.

import { recoveryCode } from "../../lib/passkey.js";
import { h, show } from "../ui.js";
import { lock, mode, secret } from "../wallet.js";

export function settingsScreen() {
  const signOut = h("button", { class: "secondary" }, "Lock Contri on this phone");
  signOut.addEventListener("click", async () => {
    await lock();
    location.hash = "#/";
    location.reload();
  });

  const code = h("p", { class: "code-block", translate: "no", hidden: true }, recoveryCode(secret()));
  const reveal = h("button", { class: "text" }, "Show my recovery code");
  reveal.addEventListener("click", () => {
    code.hidden = !code.hidden;
    reveal.textContent = code.hidden ? "Show my recovery code" : "Hide it";
  });

  show(
    h("section", { class: "stack narrow" },
      h("a", { class: "back", href: "#/" }, "Your circles"),
      h("h1", null, "Your key"),
      mode() === "passkey"
        ? h("p", null, "You sign in with a passkey. On a new phone, use the same passkey (synced by Google Password Manager or iCloud Keychain) and your circles come back.")
        : h("div", { class: "stack" },
            h("p", null, "Your key is kept in this browser. The recovery code is the only way back if this phone is lost or the browser is cleared. Anyone with it can use your circles."),
            reveal,
            code,
          ),
      h("p", null, "Every circle you're in uses its own account, made from your key. Nobody looking at the blockchain can tell they belong to the same person."),
      h("p", null, "Contri stays unlocked on this phone for 30 minutes after you last use it, so switching to your wallet or exchange doesn't lock it. Locking it now ends that."),
      h("div", { class: "actions" }, signOut),
    ),
  );
}
