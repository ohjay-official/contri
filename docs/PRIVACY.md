# Privacy

An ajo holds sensitive things: how much people save, who missed a payment, who needed the pot early. On a normal onchain savings circle all of that sits next to your wallet address, and that address leads to your exchange account and your other money.

Contri keeps **who you are** and **what your circle is** private, and is adding **where your money comes from and goes** through Confidential Intents. The one thing it keeps public is what has to be public for nobody to cheat: the contract's rules and the payments they act on, made by accounts that lead nowhere.

## What a stranger can see

| | Typical onchain savings circle | Contri |
| --- | --- | --- |
| Your name, phone number, email | Often in the app's database | Never collected |
| The circle's name and members' names | Public, or in the app's database | Encrypted. The key is only in the invite link |
| The exchange account or wallet you paid from | Traceable from the chain | Today: traceable through a one-time 1Click deposit address to the circle account only. With confidential top-ups (being tested): hidden |
| Where your payout went | Traceable from the chain | Today: traceable from the circle account through 1Click. With confidential cash-outs (being tested): hidden |
| Your other circles and total savings | Linked by your wallet address | Each circle uses its own account, derived from one passkey |
| Your track record | Public and tied to your wallet | Shown only to an organizer you choose |
| Who can join | Anyone who finds the circle | Only people with the invite link |
| That an account paid 5 USDT into circle #3 in round 2 | Public | Public, from an account tied to nothing else |

## Who could be watching, and what each learns

| Who | What they learn |
| --- | --- |
| A stranger with a block explorer | That some accounts run a circle with a given amount and schedule. Not who they are, where their money came from or went, what the circle is called, or anyone's other circles. |
| Someone who knows one of your circle accounts | Your activity in that one circle. Your other circles use accounts they can't connect to it. |
| Your exchange | That you withdrew USDT to a 1Click deposit address. Not your name in Contri: there isn't one. |
| Contri's relayer | The signed intents it submits, which are public anyway. No names, phone numbers or IP logs, and it can't read circle names or nicknames. |
| Your fellow members | What an ajo always shows its members: who is in, who paid, who got the pot, under the nicknames members chose. |
| Confidential Intents' operators | Confidential balances live on NEAR's private shard, run by permissioned validators with each user's data encrypted, and deposits are screened on the way in. Contri relies on that the same way near.com does. NEAR plans user-held view keys for selective disclosure; they are not live yet. |

## The layers

### 1. Confidential money in and out
Top-ups and cash-outs go through **Confidential Intents**, NEAR Intents' private execution layer. Its balances sit on a private shard (`intents.far`) that has no public RPC or explorer; moving between the public `intents.near` and the private side goes through NEAR's bridge.

- **Top up:** the 1Click quote uses `recipientType: CONFIDENTIAL_INTENTS`, so money from an exchange withdrawal or a wallet lands in the member's confidential balance. The public chain shows a deposit to a 1Click address and nothing that links it to the member.
- **Contribute:** the member moves one contribution from their confidential balance to their circle account (`depositType: CONFIDENTIAL_INTENTS`, `recipientType: INTENTS`). Publicly this shows an anonymous sender. The contribution itself is the usual signed `Transfer` to the contract.
- **Cash out:** the payout moves into the member's confidential balance, then out to any chain. The explorer shows an anonymous sender.

Confidential operations need a user session with 1Click: the member's key signs an empty intent (`POST /v0/auth/authenticate`), and the access token reads balances and authorizes quotes. 1Click's `generate-intent` accepts `nep413`, `raw_ed25519` and `webauthn` signatures among others.

### 2. One passkey, a separate account for every circle
A member has one passkey. When they open the app, it asks the passkey for a secret through the WebAuthn **PRF extension**. The passkey never reveals its private key, and only that passkey on that site can produce the secret. From it the app derives keys with HKDF:

- a **circle key** for the member's n-th circle, `HKDF(secret, "contri/circle/<contract>/<n>")`. It is an ed25519 key, so its account is a plain NEAR implicit account (64 hex characters), and it signs intents with the `nep413` standard (`app/public/js/lib/keys.js`);
- planned: a **vault key**, `HKDF(secret, "contri/vault")`, to hold the member's confidential balance off the public chain.

Circle accounts share nothing on chain: not a key, not a funding source, not a name. Nobody can add up a member's savings or follow them from circle to circle. On a new phone, the same synced passkey gives the same secret, and the app finds the accounts again by checking n = 0, 1, 2... until three in a row are unused, so no server holds a list.

Where a passkey can't give a PRF secret, the member can keep a random key in the browser instead, with a recovery code to write down (`app/public/js/lib/passkey.js`).

### 3. Invite-only circles (in the contract)
The organizer's app makes an ed25519 **invite key**. Its public half is stored with the circle; its secret half lives only in the invite link. To join, the joiner's app signs `contri-join:<contract>:<circle>:<joiner account>:<deposit>` with the invite key, and the contract checks the signature (`env::ed25519_verify`) before taking the seat. Because the signature names the joiner, a signature seen on chain can't be reused by anyone else. The invite also sets the deposit, so an organizer can privately ask less of someone they trust and more of a stranger. Without a valid invite, the money is refunded.

### 4. End-to-end encrypted circle details
The invite link carries a secret after `#`, which browsers never send to any server. The app derives two keys from it: the invite signing key and an AES-GCM key. The AES-GCM key encrypts:

- the circle's name, stored on chain as ciphertext (the contract stores names as given, up to 256 bytes, and seat NFTs never show them).

Only people with the link can read it. That excludes us. The app removes the secret from the address bar as soon as it has read it, so a screenshot or screen share of the app doesn't leak it. Members' nicknames, encrypted the same way, are planned.

### 5. Private track record (planned)
A member's record (circles completed, payments missed) lives on chain per account. Because every circle has its own account, nobody can see a member's history unless the member shows it. To show it, their app signs a challenge with each past circle key and sends the proofs, encrypted, to the organizer of the circle they want to join. The organizer's app checks those accounts' records on chain. Nothing public ever links the accounts together.

### 6. Nothing personal on our side
- No phone numbers, emails or names are collected.
- The relayer that submits signed intents keeps no logs of IP addresses or accounts.
- The phone reads the chain through Contri's server instead of a public RPC node, so no RPC provider sees one IP address looking up several circle accounts.
- No analytics, tracking scripts, third-party fonts or CDNs. The site sends a strict Content Security Policy (`app/vercel.json`): scripts, styles, fonts and requests only from its own origin.

The code is open source, so all of this can be checked.

## What stays public, and why
The contract replaces the person who used to hold the money, and anyone can check it does that honestly because its rules and state are public: circle ids, contribution amounts, schedules, the account in each seat, who has paid this round, payouts, deposits, backing, seat listings and sales. All of it is tied to accounts that lead nowhere.

Timing can still hint at links. If someone moves exactly one contribution out of their confidential balance a second before contributing, the two transactions sit side by side. The app moves each contribution to the circle account well ahead of the deadline, at a random moment, so the two steps don't line up.

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
| Invite-only circles, per-person deposits | In the contract, unit-tested (`invite_only_circle_needs_a_signed_invite`, `invite_can_lower_the_deposit_for_someone_trusted`, `invite_can_ask_a_stranger_to_cover_their_future_rounds`) |
| Key-only members (no NEAR account) signing NEP-413 intents | Tested end to end against NEAR Intents (`contract/sandbox`) |
| Encrypted names, none in NFT metadata | In the contract, unit-tested |
| One passkey, one account per circle (PRF) | In the app; derivation unit-tested and run end to end in the sandbox (`the_app_runs_a_circle_through_its_relayer`) |
| Encrypted circle names, invite secret only in the link fragment | In the app; tested |
| No personal data, no logs, no third-party requests, strict CSP | In the app and relayer |
| Public top-up and cash-out through 1Click | In the app |
| Confidential top-up, contribute, cash-out | To verify in the first mainnet test |
| Encrypted nicknames, private track record | Planned |
