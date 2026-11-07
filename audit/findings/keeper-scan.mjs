// Proof: the keeper's full scan stops at the first page of get_circles that
// has fewer than 100 circles, and get_circles skips closed ids. One closed
// circle among ids 0..99 hides every circle with id >= 100 from the cron keeper.
import { keep } from "/tmp/claude-0/-home-claude/93de1457-5cc6-5434-9a0f-5cb7c9295abc/scratchpad/audit/a3/contri/app/server/keeper.js";

const NOW = 2_000_000_000_000; // ms
const circle = (id) => ({
  id, status: id === 120 ? "Open" : "Finished", paying: false,
  fill_by: String(BigInt(NOW - 1000) * 1_000_000n), // past: id 120 needs cancel_circle
  members: [], backers: [], round_deadline: null,
});
async function run(closed) {
  let pages = 0;
  globalThis.fetch = async (_url, init) => {
    const { params } = JSON.parse(init.body);
    const args = JSON.parse(Buffer.from(params.args_base64, "base64").toString());
    if (params.method_name !== "get_circles") throw new Error("unexpected " + params.method_name);
    pages++;
    const out = [];
    for (let id = args.from_index; id < Math.min(150, args.from_index + args.limit); id++) if (!closed.has(id)) out.push(circle(id));
    const bytes = [...Buffer.from(JSON.stringify(out))];
    return new Response(JSON.stringify({ result: { result: bytes } }));
  };
  const c = { contractId: "circles.contring.near", relayerId: "contring.near", relayerKey: "ed25519:dummy", rpcUrl: "http://rpc" };
  try {
    const r = await keep({}, c, NOW);
    return `pages=${pages} todo empty, returned ${JSON.stringify(r)} -> circle 120 MISSED`;
  } catch (e) {
    return `pages=${pages} keeper found work and tried to sign (${e.message.slice(0, 40)}) -> circle 120 seen`;
  }
}
console.log("no closed circle:      ", await run(new Set()));
console.log("circle 5 closed:       ", await run(new Set([5])));
