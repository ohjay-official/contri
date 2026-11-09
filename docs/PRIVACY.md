# Privacy

An ajo holds sensitive things: how much people save, who missed a payment, who needed the pot early. On a normal onchain savings circle all of that sits next to your wallet address, and that address leads to your exchange account and your other money.

Contri keeps **who you are** and **what your circle is** private, and, through each member's **private balance** on Confidential Intents, **where your money comes from and goes**. The one thing it keeps public is what has to be public for nobody to cheat: the contract's rules and the payments they act on, made by accounts that don't name anyone. Some things can still link a member's activity, and this page says which.

## What a stranger can see

| | Typical onchain savings circle | Contri |
| --- | --- | --- |
| Your name, phone number, email | Often in the app's database | Never collected |
| The circle's name | Public, or in the app's database | Encrypted. The key is only in the invite link |
| The exchange account or wallet you paid from | Traceable from the chain | Every top-up takes NEAR Intents' confidential route: the deposit address can't be looked up to find the circle account (1Click's public status answers 404). Paid from the private balance: the circle account receives from NEAR Intents' private ledger |
| Where your payout went | Traceable from the chain | Moved to the private balance: it leaves the public chain. Cashed out directly: by the confidential route, so the deposit address can't be looked up to find your wallet |
| How much you hold | Your wallet's balance is public | Your private balance is on the private ledger, which has no public explorer |
| Your other circles and total savings | Linked by your wallet address | Each circle uses its own account, derived from one passkey, so circle accounts aren't linked by keys on chain. Amounts, timing and private-balance moves still can link them (below) |
| Your track record | Public and tied to your wallet | Kept on chain per circle account, so it isn't tied to your other circles. Showing it to an organizer is planned |
| Who can join | Anyone who finds the circle | Only people with the invite link |
| That an account paid 5 USDT into circle #3 in round 2 | Public | Public, from an account that doesn't name anyone |

Amounts and timing are the limit everywhere: a $3.02 withdrawal from an exchange and a circle account receiving $3.00 a minute later can be matched by someone watching both chains, even though no address links them. Holding money in the private balance and paying circles from it over time is what breaks that.

## Who could be watching, and what each learns

| Who | What they learn |
| --- | --- |
| A stranger with a block explorer | That some accounts run a circle with a given amount and schedule. Not who they are, what the circle is called, or which wallet paid in (beyond what amounts and timing suggest). Contri's 0.25% fee on each top-up and cash-out is paid to Contri's own public NEAR Intents account, so its size and timing can show that a deposit or withdrawal on another chain went through Contri, though not which circle account or private account it went to or came from. |
| Someone who knows one of your circle accounts | Your activity in that one circle. Your other circles use accounts no key or address connects to it, though matching amounts and times can hint at them. |
| Your exchange | That you withdrew USDT to a 1Click deposit address. Because Contri uses the confidential route, it can't look up which circle account that paid. |
| 1Click | Both ends of each move it routes: a top-up's deposit and the circle account or private account it pays; a payment from the private balance, your private account and that circle account. Because every private move names your one private account, 1Click can tell which circle accounts belong to the same member, and it sees that the swaps come from Contri (`referral: contri`). It doesn't know who you are. |
| Contri's server | The signed intents it relays, which are public anyway; the circle accounts one phone looks up together each time the app opens; every cash-out request, which names the circle account or private account with the address the money goes to; your private balance each time the app reads it, with the 15-minute session token used to read it (1Click also hands the server a 7-day refresh token, which Contri's code discards); every top-up and cash-out on a phone at once when Help is opened; and, for private-balance moves (`privateHome`, `privateMove` in `app/server/confidential.js`), the request naming your private account and the circle account together, so it could link your circles. Contri's code stores none of it: the only thing written anywhere is a rate-limit count per salted IP hash and per paying account, in Upstash Redis, deleted after two minutes. Vercel, which runs the server, records each request (time, path, status, browser and IP address, not request bodies); on Contri's plan they can be seen for an hour, and Vercel's own retention follows its privacy policy. So the server could link your circles to each other and to your wallet; Contri's code doesn't. It can't read circle names. |
| Your fellow members | What an ajo always shows its members: who is in, who paid, who got the pot, as account numbers plus any names you give them on your own phone. |
| NEAR Intents' operators | Confidential balances live on FAR, a permissioned NEAR network run by a small validator set, with no public RPC. Its operators can see private balances and moves; the public can't. Contri relies on that the same way near.com does. |

## The layers

### 1. The private balance (Confidential Intents)
Every member has one **private account**, derived from their passkey, on **Confidential Intents**, NEAR Intents' private execution layer. Its balances sit on a private ledger (`intents.far`) that has no public RPC or explorer. Money moves between it and the public `intents.near` only through 1Click.

| Move | 1Click quote | Who signs |
| --- | --- | --- |
| **Add privately**: exchange or wallet to private balance | `ORIGIN_CHAIN` to `CONFIDENTIAL_INTENTS`, refunds to the private balance, `confidentiality: basic` | Nobody: the member sends to a one-time deposit address |
| **Pay a circle from it**: private balance to a circle account | `CONFIDENTIAL_INTENTS` to `INTENTS`, refunds to the private balance | The private account signs the intent 1Click builds (`/v0/generate-intent`) |
| **Take a payout home**: circle account to private balance | `INTENTS` to `CONFIDENTIAL_INTENTS`, refunds to the circle account | The circle account signs a plain `Transfer` to 1Click's deposit account, relayed by Contri |
| **Cash out privately**: private balance to an exchange or wallet | `CONFIDENTIAL_INTENTS` to `DESTINATION_CHAIN` | The private account signs the intent 1Click builds |

So on the public chain, a circle account's money arrives from 1Click and leaves to 1Click. The exchange it was funded from, the wallet a payout went to, and the member's other circles don't appear. Direct top-ups and cash-outs (straight between a wallet and a circle account) also ask for the confidential route (`confidentiality: basic`, `app/server/oneclick.js`), so their deposit addresses can't be looked up on 1Click either; the live check after each deploy asserts it.

**The phone checks before it signs.** 1Click builds the intents that move money out of the private balance, so the app doesn't sign them blindly. Before signing, it checks the intent is exactly one `transfer`, from the member's private account, of USDT, of the amount the member asked for, to the deposit address 1Click quoted, with no call attached and a deadline within a week (`app/public/js/lib/private.js`). Anything else is refused and nothing moves. It can't check where 1Click sends the money from that deposit address; that relies on Contri's server passing 1Click's quote on unchanged. Contri's server runs the same check, without the amount, before passing a signed intent on, so Contri's 1Click key can't be used to submit anything else (`app/server/confidential.js`).

**Reading the balance** needs a 1Click session: the private account signs an empty intent (`/v0/auth/authenticate`) and gets a token that lasts 15 minutes. The page keeps it in memory and sends it through Contri's server each time it reads the balance, so the server sees the token and the balance. Moves don't use the session: the member's signature authorizes them.

### 2. One passkey, a separate account for every circle
A member has one passkey. When they open the app, it asks the passkey for a secret through the WebAuthn **PRF extension**. The passkey never reveals its private key, and only that passkey on that site can produce the secret. From it the app derives keys with HKDF:

- a **circle key** for the member's n-th circle, `HKDF(secret, "contri/circle/<contract>/<n>")`. It is an ed25519 key, so its account is a plain NEAR implicit account (64 hex characters), and it signs intents with the `nep413` standard (`app/public/js/lib/keys.js`);
- a **private account key**, `HKDF(secret, "contri/vault/<contract>")`, for the member's private balance. It never appears on the public chain.

Circle accounts aren't linked by keys on chain: they share no key and no name, and money reaches them by the confidential route, so no address ties them together either. Three things can still link them: amounts and timing; private-balance moves, where 1Click and Contri's server see the private account and the circle account in the same request; and the app looking up all of a phone's circle accounts through Contri's server when it opens. On a new phone, the same synced passkey gives the same secret, and the app finds the accounts again by checking n = 0, 1, 2... until three in a row are unused, so no server holds a list.

Once unlocked, Contri stays unlocked on that device until the member locks it, so a phone reloading the page in the background (iOS Safari does this within seconds), a closed tab or a restarted browser doesn't ask for the passkey again. The device's own screen lock protects it, as with a messaging app. Cash-outs to an outside address and showing the recovery code ask for the passkey again. Joining a circle, buying a turn, paying a round and moving the private balance into your own circle account don't. A new passkey is found again once, the way signing in does, before anything is kept behind it: some phones save a passkey they then can't find, and this catches that while the account is empty, with a key kept on the device as the way on. The secret is kept sealed with AES-GCM under a key the browser marks non-extractable and keeps in IndexedDB: page scripts can use it but can't export it. It isn't tied to the phone's hardware, so anyone who can use the unlocked browser can open Contri. Locking deletes both (`app/public/js/lib/session.js`). The same code runs in Chrome, Edge, Samsung Internet, Firefox and Safari, on phones and computers, and is tested in all three browser engines after every deploy.

Where a passkey can't give a PRF secret, the member can keep a random key in the browser instead, unencrypted, with a recovery code to write down (`app/public/js/lib/passkey.js`). That is like a hot wallet: anything that can read the browser's storage (someone with the unlocked device, malware, or a script injected into the page despite the CSP) can take the key and every circle account made from it. The app says so where the key is made and on Your key, and suggests keeping small amounts that way. Removing it (Your key, then Remove my key from this device) is its lock. Restoring from a recovery code also keeps the secret this way. Passkey members get a recovery code too: passkeys only work on contri.ng, and whoever controls that domain can ask a passkey for the same secret. So the code is the way back if the passkey is deleted, and if the site ever goes away or changes hands, members should restore from the code in the open-source app and not use the passkey there again.

### 3. Invite-only circles (in the contract)
The organizer's app makes an ed25519 **invite key**. Its public half is stored with the circle; its secret half lives only in the invite link. To join, the joiner's app signs `contri-join:<contract>:<circle>:<joiner account>:<deposit>` with the invite key, and the contract checks the signature (`env::ed25519_verify`) before taking the seat. Because the signature names the joiner, a signature seen on chain can't be reused by anyone else. Everyone with the link holds the same invite key, so the deposit can't be set per person: the contract takes exactly one contribution as every member's deposit. Without a valid invite, the money is refunded.

### 4. End-to-end encrypted circle details
The invite link carries a secret after `#`, which browsers don't send to the site. Sharing the link through an app passes it on, with the circle's name in the message. The app derives two keys from it: the invite signing key and an AES-GCM key. The AES-GCM key encrypts:

- the circle's name, stored on chain as ciphertext (the contract stores names as given, up to 256 bytes, and seat NFTs never show them). Its length is visible.

Only people with the link can read it. That excludes us. In Chrome or Safari, the app takes the secret out of the address bar as soon as it has read it, so a screenshot of the join screen doesn't show it. In an app's built-in browser it stays, so Open in browser keeps the invite working. While a circle is filling, its screen shows the whole link so members can share it, and the app it's shared through carries it. Members' nicknames, encrypted the same way, are planned.

### 5. Private track record (planned)
A member's record (circles completed, payments missed) lives on chain per account. Because every circle has its own account, nobody can see a member's history unless the member shows it. To show it, their app signs a challenge with each past circle key and sends the proofs, encrypted, to the organizer of the circle they want to join. The organizer's app checks those accounts' records on chain. Nothing public ever links the accounts together.

### 6. Nothing personal on our side
- No phone numbers, emails or names are collected.
- The relayer stores nothing, and Contri's code writes no logs. Vercel, which hosts it, records each request (time, path, browser and IP address); on Contri's plan they can be seen for an hour.
- To limit how fast anyone can call it, the server counts requests per caller and per paying account for one minute. Callers are counted by a hash of the IP address, salted with a secret derived from the relayer's key, which Upstash doesn't hold. With Redis connected (Upstash, through Vercel) the counts are shared by every server instance and each one is deleted after two minutes; without it they stay in each instance's memory (`app/server/limit.js`). A count is kept per paying account too, which is public on chain anyway.
- The phone reads the chain through Contri's server instead of a public RPC node, so RPC providers never see a member's IP address. They do receive a phone's account lookups together, at the same moment, so with little traffic they could group them.
- No analytics, tracking scripts, third-party fonts or CDNs. The site sends a strict Content Security Policy (`app/vercel.json`): scripts, styles, fonts and requests only from its own origin.

The code is open source, so all of this can be checked.

## What stays public, and why
The contract replaces the person who used to hold the money, and anyone can check it does that honestly because its rules and state are public: circle ids, contribution amounts, schedules, the account in each seat, who has paid this round, payouts, deposits, backing, seat listings and sales. All of it is tied to accounts that don't name anyone.

Amounts and timing can still hint at links. A deposit of $3.02 from an exchange and a circle account receiving $3.00 a minute later can be matched by someone watching both chains, even though no address links them. The private balance helps only if it is used like a wallet: add more than one round's worth, pay circles from it over time. The app says so where the member adds money, and suggests it rather than enforcing it.

## What we researched and set aside

| Idea | What we found | Decision |
| --- | --- | --- |
| Keep the pot itself in a confidential balance, signed by the contract through Chain Signatures | Works for DAO treasuries (Trezu signs 1Click intents with `v1.signer`). But the contract would sign intents built by 1Click without being able to check where they route, and the circle's public rules already show who is paid each round, so it hides nothing more | Not used |
| Each circle as its own contract account (NEP-616 deterministic accounts on a NEP-591 global contract) | Isolates every pot and deletes itself when done. Publishing a global contract burns 10× normal storage, about 10 NEAR for this contract | Later |
| NEAR's passkey smart wallets (`0s…` accounts on the WebAuthn wallet contract, NEAR Connect Passkey) | Real NEAR accounts from one passkey, with sub-wallets. But every sub-wallet keeps the same passkey public key in its state, which links them | Fine for members who want a NEAR account; not used for circle accounts |
| Cash out to shielded Zcash | NEAR Intents can't quote unified (shielded) Zcash addresses yet | Not available |
| Zero-knowledge membership and stealth payouts | Would hide payers even inside a circle, but members are meant to see each other, and one account per circle already makes every account lead nowhere | Not needed |
| Sealed circles: the rules run in a TEE that holds a confidential pot (NEAR AI Cloud, Shade Agents) | Would hide the circle itself from the public, at the cost of trusting hardware attestation instead of a public contract | Later |

## Status

| Layer | Status |
| --- | --- |
| Invite-only circles | In the contract, unit-tested (`invite_only_circle_needs_a_signed_invite`) |
| Key-only members (no NEAR account) signing NEP-413 intents | Tested end to end against NEAR Intents (`contract/sandbox`) |
| Encrypted names, none in NFT metadata | In the contract, unit-tested |
| One passkey, one account per circle (PRF) | In the app; derivation unit-tested and run end to end in the sandbox (`the_app_runs_a_circle_through_its_relayer`) |
| Encrypted circle names, invite secret only in the link fragment | In the app; tested |
| No personal data, no application logs, no third-party requests from the browser, strict CSP | In the app and relayer |
| Direct top-up and cash-out through 1Click, by the confidential route | In the app; run with real money on 5 November 2026; after every deploy `scripts/live-check.mjs` checks the quotes and that 1Click's public lookup hides the circle account |
| Private balance: add, pay a circle, take a payout home, cash out | In the app. The phone's check and the server's are unit-tested (`app/test/private.test.js`); every call runs against 1Click on mainnet with an empty private account after each deploy (`scripts/live-check.mjs`). Run with real money on 5 November 2026: add privately, pay a circle from it, move a payout home, cash out (see the README) |
| Encrypted nicknames, private track record | Planned |
