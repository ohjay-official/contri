// @ts-check
// Routes:  /app#/  /app#/new  /app#/c/<circle>  /app#/add/<slot>  /app#/cash/<slot>  /app#/settings
// and /join#<circle>.<secret> for invite links.

import { parseInvite } from "../lib/invite.js";
import { getConfig } from "./api.js";
import { cashOutScreen } from "./screens/cashout.js";
import { circleScreen } from "./screens/circle.js";
import { createScreen } from "./screens/create.js";
import { fundScreen } from "./screens/fund.js";
import { homeScreen } from "./screens/home.js";
import { joinScreen } from "./screens/join.js";
import { settingsScreen } from "./screens/settings.js";
import { unlockScreen } from "./screens/unlock.js";
import { h, notice, show } from "./ui.js";
import { restore, unlocked } from "./wallet.js";

async function route() {
  const hash = location.hash || "#/";
  if (!unlocked()) return unlockScreen(() => route());
  /** @type {RegExpExecArray | null} */
  let m;
  if (hash === "#/" || hash === "#") return homeScreen();
  if (hash === "#/new") return createScreen();
  if (hash === "#/settings") return settingsScreen();
  if ((m = /^#\/c\/(\d+)(\?share)?$/.exec(hash))) return circleScreen(Number(m[1]), Boolean(m[2]));
  if ((m = /^#\/add\/(\d+)$/.exec(hash))) return fundScreen(Number(m[1]));
  if ((m = /^#\/cash\/(\d+)$/.exec(hash))) return cashOutScreen(Number(m[1]));
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
  restore();
  const cfg = await getConfig().catch(() => null);
  if (cfg && !cfg.contractId) notice("Contri isn't connected to a contract yet. Nothing here will work until it is.", "error");
  const invite = location.pathname.startsWith("/join") ? parseInvite(location.hash) : null;
  if (location.pathname.startsWith("/join") && !invite) {
    history.replaceState(null, "", "/app");
    notice("That invite link is incomplete. Ask for it again and open the whole link.", "error");
  }
  window.addEventListener("hashchange", () => run(route));
  await run(() => (invite ? joinScreen(invite) : route()));
}

main();
