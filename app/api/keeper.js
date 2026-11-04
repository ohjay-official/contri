// @ts-check
// GET /api/keeper            every circle (Vercel cron)
// POST /api/keeper {circle}  one circle, when the app sees it needs settling
import { handler } from "../server/http.js";
import { keep } from "../server/keeper.js";

export const GET = handler((_, c) => keep({}, c));
export const POST = handler(keep);
