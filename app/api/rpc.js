// @ts-check
// POST /api/rpc  { calls: [{ contract: "contri" | "intents", method, args }] }
// Read-only views, so members' phones never talk to an RPC provider directly.
import { handler } from "../server/http.js";
import { views } from "../server/views.js";

export const POST = handler(views, { name: "rpc", perMinute: 240 });
