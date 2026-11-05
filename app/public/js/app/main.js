// @ts-check
// Routes:  /app#/  /app#/explore  /app#/new  /app#/c/<circle>  /app#/add/<slot>  /app#/cash/<slot>  /app#/settings  /app#/help
// the private balance: /app#/private/add(/<slot>)  /app#/private/cash
// /app#/invite: the invite opened in this tab (the link's secret is kept for the tab, not in the address bar)
// and /join#<circle>.<secret> for invite links.

import { parseInvite } from "../lib/invite.js";
import { inAppBrowser } from "../lib/support.js";
import { getConfig } from "./api.js";
import { cashOutScreen } from "./screens/cashout.js";
import { circleScreen } from "./screens/circle.js";
import { createScreen } from "./screens/create.js";
import { exploreScreen } from "./screens/explore.js";
import { fundScreen } from "./screens/fund.js";
import { helpScreen } from "./screens/help.js";
import { homeScreen } from "./screens/home.js";
import { joinScreen } from "./screens/join.js";
import { privateAddScreen } from "./screens/private.js";
import { settingsScreen } from "./screens/settings.js";
import { unlockScreen } from "./screens/unlock.js";
import { h, notice, show } from "./ui.js";
import { restore, unlocked } from "./wallet.js";

/** The invite being looked at, kept for this tab so a reload doesn't lose it. */
const INVITE = "contri.invite";
const savedInvite = () => {
  try {
    return parseInvite(sessionStorage.getItem(INVITE) ?? "");
  } catch {
    return null;
  }
};

async function route() {
  const hash = location.hash || "#/";
  if (hash === "#/explore") return exploreScreen();
  if (hash === "#/invite") {
    const invite = savedInvite();
    return invite ? joinScreen(invite) : void (location.hash = "#/");
  }
  // Through run(), so anything that fails right after unlocking shows its error instead of a blank screen.
  if (!unlocked()) return unlockScreen(() => run(route));
  /** @type {RegExpExecArray | null} */
  let m;
  if (hash === "#/" || hash === "#") return homeScreen();
  if (hash === "#/new") return createScreen();
  if (hash === "#/settings") return settingsScreen();
  if (hash === "#/help") return helpScreen();
  if ((m = /^#\/c\/(\d+)(\?share)?$/.exec(hash))) return circleScreen(Number(m[1]), Boolean(m[2]));
  if ((m = /^#\/add\/(\d+)$/.exec(hash))) return fundScreen(Number(m[1]));
  if ((m = /^#\/cash\/(\d+)$/.exec(hash))) return cashOutScreen(Number(m[1]));
  if ((m = /^#\/private\/add(?:\/(\d+))?$/.exec(hash))) return privateAddScreen(m[1] === undefined ? null : Number(m[1]));
  if (hash === "#/private/cash") return cashOutScreen("private");
  location.hash = "#/";
}

/** @param {() => Promise<void> | void} fn */
async function run(fn) {
  try {
    await fn();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    show(
      h("section", { class: "stack narrow" },
        h("h1", null, "That didn't load"),
        h("p", null, message),
        h("div", { class: "actions" }, h("button", { class: "secondary", onclick: () => run(route) }, "Try again"), h("a", { class: "button text", href: "#/" }, "Your circles")),
      ),
    );
  }
}

async function main() {
  await restore();
  const cfg = await getConfig().catch(() => null);
  if (cfg && !cfg.contractId) notice("Contri isn't connected to a contract yet. Nothing here will work until it is.", "error");
  if (location.pathname.startsWith("/join")) {
    const invite = parseInvite(location.hash);
    if (invite) {
      try {
        sessionStorage.setItem(INVITE, location.hash);
      } catch {
        // Private mode: the invite lasts until the page closes.
      }
      // The link's secret leaves the address bar, so a screenshot or a shared
      // screen doesn't give it away. In an app's built-in browser it stays, so
      // "Open in browser" carries the whole invite to Chrome or Safari.
      if (!inAppBrowser()) history.replaceState(null, "", "/app#/invite");
      window.addEventListener("hashchange", () => run(route));
      return run(() => joinScreen(invite));
    }
    if (location.hash.startsWith("#/")) history.replaceState(null, "", `/app${location.hash}`);
    else {
      history.replaceState(null, "", "/app");
      notice("That invite link is incomplete. Ask for it again and open the whole link.", "error");
    }
  }
  window.addEventListener("hashchange", () => run(route));
  await run(route);
}

main();
