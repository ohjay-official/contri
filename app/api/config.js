// @ts-check
// GET /api/config: the contract, token and network the app works with.
import { publicConfig } from "../server/config.js";
import { handler } from "../server/http.js";

export const GET = handler(async (_, c) => publicConfig(c));
