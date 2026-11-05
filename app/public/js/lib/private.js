// @ts-check
// Checks an intent that moves money out of a member's private balance.
//
// 1Click builds these intents (`/v0/generate-intent`) and the member's app
// signs them. Before signing, the app checks the intent does exactly what the
// member asked: one transfer, of the circle's token, of the amount asked, to
// the deposit address 1Click quoted, from the member's own private account,
// with nothing attached. Contri's server runs the same check, without the
// amount, before it passes a signed intent on.
//
// On the private ledger a token's id is wrapped: `imt:<issuer>:<token id>`.

const MAX_VALID_MS = 7 * 24 * 3_600_000;

/**
 * @param {string} message the NEP-413 payload's message
 * @param {{ signer: string, tokenId: string, depositAddress?: string, amount?: string, now?: number }} expect
 * @returns {{ receiver: string, amount: string }}
 */
export function checkPrivateMove(message, { signer, tokenId, depositAddress, amount, now = Date.now() }) {
  /** @type {any} */
  let m;
  try {
    m = JSON.parse(message);
  } catch {
    throw new Error("the intent isn't JSON");
  }
  if (m?.signer_id !== signer) throw new Error("the intent isn't from your private account");
  const deadline = Date.parse(m.deadline);
  if (!(deadline > now && deadline <= now + MAX_VALID_MS)) throw new Error("the intent's deadline is wrong");
  if (!Array.isArray(m.intents) || m.intents.length !== 1) throw new Error("expected exactly one intent");
  const i = m.intents[0];
  if (i?.intent !== "transfer") throw new Error(`expected a transfer, got "${i?.intent}"`);
  if (typeof i.receiver_id !== "string" || !/^[0-9a-f]{64}$/.test(i.receiver_id)) throw new Error("the receiver isn't a deposit address");
  if (depositAddress !== undefined && i.receiver_id !== depositAddress) throw new Error("the receiver isn't the quoted deposit address");
  if (i.msg !== undefined || i.min_gas !== undefined) throw new Error("the transfer carries a call");
  const tokens = Object.entries(i.tokens ?? {});
  if (tokens.length !== 1) throw new Error("the transfer moves more than one token");
  const [id, value] = tokens[0];
  if (id !== tokenId && !(id.startsWith("imt:") && id.endsWith(`:${tokenId}`))) throw new Error("the transfer moves a different token");
  if (typeof value !== "string" || !/^\d{1,30}$/.test(value) || BigInt(value) === 0n) throw new Error("the amount is malformed");
  if (amount !== undefined && value !== amount) throw new Error("the amount isn't the one you asked for");
  return { receiver: i.receiver_id, amount: value };
}
