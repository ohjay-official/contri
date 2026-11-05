// @ts-check
// What the browser a member opened Contri in can do.

import { signerFromSeed } from "./keys.js";

/**
 * An app's built-in browser (WhatsApp, Instagram, Facebook, X, TikTok...).
 * Passkeys usually don't work there, and a key kept there can be wiped with
 * the app's data, so members are sent to Chrome or Safari instead.
 * @param {string} [ua]
 */
export function inAppBrowser(ua = typeof navigator === "undefined" ? "" : navigator.userAgent) {
  if (/FBAN|FBAV|FB_IAB|Instagram|Line\/|Snapchat|TikTok|musical_ly|BytedanceWebview|Twitter|WhatsApp|MicroMessenger/i.test(ua)) return true;
  if (/Android/.test(ua) && /; wv\)/.test(ua)) return true; // Android WebView
  if (/iPhone|iPad|iPod/.test(ua) && !/Safari\//.test(ua)) return true; // iOS web view without Safari
  return false;
}

/** @type {Promise<boolean> | null} */
let keysCheck = null;
/** Whether this browser can make and use Contri's ed25519 keys (WebCrypto Ed25519). */
export const canUseKeys = () =>
  (keysCheck ??= signerFromSeed(new Uint8Array(32).fill(1))
    .then((s) => s.sign(new Uint8Array(1)))
    .then(() => true, () => false));
