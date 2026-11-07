// @ts-check
// The demo at /demo: the real app's screens against a pretend chain that runs
// in this tab (js/demo/mock.js). No money, no passkey, no server calls, and
// nothing kept after the tab closes except the demo's own notes, which can't
// touch a real member's keys or circles.

const path = globalThis.location?.pathname ?? "";
export const demo = path === "/demo" || path.startsWith("/demo/");
