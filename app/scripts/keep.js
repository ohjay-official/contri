// @ts-check
// Runs the keeper once over every circle: settles rounds past their deadline,
// retries stuck payouts, returns deposits of circles that ended. Scheduled by
// .github/workflows/keeper.yml; the app also asks for it when it opens a
// circle that needs it. Env: CONTRI_ACCOUNT_ID, RELAYER_ACCOUNT_ID, RELAYER_KEY.

import { config } from "../server/config.js";
import { keep } from "../server/keeper.js";

const c = config();
if (!c.contractId || !c.relayerId || !c.relayerKey) {
  console.log("keeper: not set up yet (secrets missing), nothing to do");
} else {
  const { done } = await keep({}, c);
  console.log(done.length ? JSON.stringify(done, null, 2) : "keeper: no circle needs anything");
}
