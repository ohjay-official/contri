// @ts-check
// POST /api/relay  { signed: [<NEP-413 signed intents>] }
// Checks, simulates and submits a member's signed intents; Contri pays the gas.
import { handler } from "../server/http.js";
import { relay } from "../server/relay.js";

export const POST = handler(relay, { name: "relay", perMinute: 20 });
