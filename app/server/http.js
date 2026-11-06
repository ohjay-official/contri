// @ts-check
// Wraps a server function as a web-standard request handler (what Vercel
// Functions and the local dev server call). Errors meant for the member are
// returned as `{ error }`; anything else becomes a generic message. Nothing is
// logged: not the request, not the IP address, not the error.

import { config } from "./config.js";
import { allowShared, caller } from "./limit.js";
import { RelayError } from "./relay.js";

const MAX_BODY = 64 * 1024;

/**
 * @param {(body: any, c: import("./config.js").Config, who: string) => Promise<unknown>} fn
 * @param {{ name: string, perMinute: number }} [limit] requests per caller per minute (see limit.js)
 * @returns {(request: Request) => Promise<Response>}
 */
export function handler(fn, limit) {
  return async (request) => {
    try {
      const who = await caller(request);
      if (limit && who && !(await allowShared(`${limit.name}:${who}`, limit.perMinute))) throw new RelayError("Too many requests. Wait a minute and try again.", 429);
      let body = {};
      if (request.method === "POST") {
        const text = await request.text();
        if (text.length > MAX_BODY) throw new RelayError("request too large", 413);
        try {
          body = text ? JSON.parse(text) : {};
        } catch {
          throw new RelayError("the request isn't JSON");
        }
      } else {
        body = Object.fromEntries(new URL(request.url).searchParams);
      }
      return json(await fn(body, config(), who));
    } catch (e) {
      if (e instanceof RelayError) return json({ error: e.message }, e.status);
      return json({ error: "Something went wrong on our side. Refresh to see what went through before you try again." }, 500);
    }
  };
}

/** @param {unknown} data @param {number} [status] */
export function json(data, status = 200) {
  return new Response(JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v)), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
