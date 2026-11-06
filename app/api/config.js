// @ts-check
// GET /api/config: the contract, token and network the app works with.
import { publicConfig } from "../server/config.js";
import { handler } from "../server/http.js";
import { limitsCheck } from "../server/limit.js";

// ?check=limits also says whether the shared request limits reach their database.
export const GET = handler(async (q, c) => (q.check === "limits" ? { ...publicConfig(c), limits: await limitsCheck() } : publicConfig(c)));
