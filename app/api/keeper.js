// @ts-check
// GET /api/keeper            every circle (Vercel cron)
// POST /api/keeper {circle}  one circle, when the app sees it needs settling
import { handler } from "../server/http.js";
import { keep } from "../server/keeper.js";

export const GET = handler((_, c) => keep({}, c), { name: "keeper-all", perMinute: 2 });
export const POST = handler((body, c) => keep(body, c), { name: "keeper", perMinute: 10 });
