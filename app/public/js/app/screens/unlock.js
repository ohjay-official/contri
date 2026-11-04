// @ts-check
// Opening Contri: a passkey, or a key kept on this device.

import { recoveryCode, restoreDeviceSecret, passkeysAvailable, PrfUnavailable } from "../../lib/passkey.js";
import { busy, field, h, notice, show } from "../ui.js";
import { secret, signInWithPasskey, signUpWithPasskey, useRestoredSecret, useThisDevice } from "../wallet.js";

/** @param {() => void} done what to open once unlocked @param {string} [reason] a line about why, e.g. joining a circle */
export function unlockScreen(done, reason) {
  /** @param {unknown} e */
  const failed = (e) => {
    if (e instanceof PrfUnavailable) return notice(e.message, "error");
    if (e instanceof DOMException && e.name === "NotAllowedError") return notice("The passkey prompt was closed. Try again when you're ready.", "error");
    throw e;
  };
  const create = h("button", { class: "primary" }, "Create a passkey");
  create.addEventListener("click", () => busy(create, "Waiting for your passkey", () => signUpWithPasskey().then(done, failed)));
  const signIn = h("button", { class: "secondary" }, "I already have a Contri passkey");
  signIn.addEventListener("click", () => busy(signIn, "Waiting for your passkey", () => signInWithPasskey().then(done, failed)));

  const device = h("button", { class: "text" }, "Keep my key on this device instead");
  device.addEventListener("click", () => {
    const created = useThisDevice();
    if (created) recoveryScreen(done);
    else done();
  });
  const restore = h("button", { class: "text" }, "Restore from a recovery code");
  restore.addEventListener("click", () => restoreScreen(done));

  show(
    h("section", { class: "stack narrow" },
      h("h1", null, "Open Contri"),
      reason ? h("p", { class: "lead" }, reason) : null,
      h("p", null, "Contri signs you in with a passkey: the fingerprint, face or screen lock you already use on this phone. There is no email, phone number or password, and we keep nothing about you."),
      passkeysAvailable()
        ? h("div", { class: "actions" }, create, signIn)
        : h("p", { class: "callout" }, "This browser can't use passkeys. Keep your key on this device below, or open Contri in Chrome or Safari."),
      h("details", { class: "more" },
        h("summary", null, "Other ways in"),
        h("p", null, "Without a passkey, your key stays in this browser only. You'll get a recovery code to write down: it's the only way back in if this phone is lost."),
        h("div", { class: "actions" }, device, restore),
      ),
    ),
  );
}

/** Shown once, right after a device key is made. @param {() => void} done */
function recoveryScreen(done) {
  const code = recoveryCode(secret());
  const ok = h("button", { class: "primary" }, "I've written it down");
  ok.addEventListener("click", done);
  show(
    h("section", { class: "stack narrow" },
      h("h1", null, "Write down your recovery code"),
      h("p", null, "Your key is kept in this browser. If you clear it or lose this phone, this code is the only way to get back to your circles and your money. Anyone with it can use them, so keep it private and offline."),
      h("p", { class: "code-block", translate: "no" }, code),
      h("div", { class: "actions" }, ok),
    ),
  );
}

/** @param {() => void} done */
function restoreScreen(done) {
  const input = /** @type {HTMLTextAreaElement} */ (h("textarea", { rows: 3, autocomplete: "off", spellcheck: false, autocapitalize: "off" }));
  const go = h("button", { class: "primary" }, "Restore");
  go.addEventListener("click", () =>
    busy(go, "Restoring", async () => {
      useRestoredSecret(restoreDeviceSecret(input.value));
      done();
    }),
  );
  show(
    h("section", { class: "stack narrow" },
      h("h1", null, "Restore from a recovery code"),
      field("Recovery code", input, "The code you wrote down when you set up this device."),
      h("div", { class: "actions" }, go),
    ),
  );
}
