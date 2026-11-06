# Contri claims audit

Checked on 5 November 2026 against the repo at `06e8096` (identical to what https://contri.ng serves: every page and screen file compared byte for byte) and mainnet state (blocks ~223,162,160).

Style of replacements: plain, short, no em dashes. Where a sentence becomes true once the contract is locked, both versions are given.

---

## 0. The seven things that matter most

1. **The contract can still be changed, and its key is a hot server key.** `circles.contring.near` has one FullAccess key, `ed25519:8ikg3ZpEFprsK79HQUwWA4MBKsnWQAoCejoJDcDEyK3x`. It is the same key, and the only key, on `contring.near`, the relayer account. So the key in Vercel's `RELAYER_KEY` env var and in GitHub Actions secrets (keeper runs every 10 minutes) can redeploy the contract, or call `intents.near` directly as `circles.contring.near` and move every pot (predecessor auth is enabled for the account). Every "nobody can move it / not even us / no keys on its account" sentence is false today (section 1).
2. **"Keeps no logs" is false at the platform level.** Contri's code logs nothing (verified: no `console.*` in `app/server` or `app/api`). Vercel records every function request by default: method, path, status, host, user agent, region, outgoing sub-requests, and matches on IP address; kept 1 hour on Hobby, 1 day on Pro. `privacy.html` says this; README, PRIVACY.md, how-it-works and the unlock screen don't (section 2.1).
3. **A direct top-up publicly links the wallet to the circle account.** 1Click's `/v0/status` is public and unauthenticated. For a Contri top-up deposit address it returns `recipient` (the circle account), `refundTo` and `referral: "contri"` (tested live). So the exchange, or anyone who sees a wallet pay that address, can find the circle account. "An account number that leads nowhere", "nothing on chain connects them" and "Your exchange: not your name" are overstated for the default top-up route. Private top-ups and move-home addresses return 404 there, so the private route holds up (section 2.2).
4. **Per-person invite deposits aren't real.** The app puts one invite secret in one link for everyone. Whoever holds the link holds the invite signing key, so a joiner can sign their own deposit, from 0.000001 USDT up to (size - 1) contributions. The contract accepts it. "Everyone puts down one contribution" is enforced only by the honest app, and "an organizer can privately ask less of someone they trust and more of a stranger" can't work with a shared link. Fix this in the contract before locking (section 3).
5. **"Lock Contri on this device" doesn't lock device-key users.** `lock()` deletes the sealed session but leaves `contri.device-secret` unencrypted in localStorage. "Other ways in > Keep my key on this device instead" then opens everything with no prompt. The Settings advice "Lock it if other people use this device" is false for them (section 2.7).
6. **"What if Contri disappears?" is answered wrongly.** Passkeys are bound to the site (`rp.id` defaults to contri.ng). If contri.ng goes away, a passkey can't produce the PRF secret anywhere else, so only the recovery code reaches the money. The FAQ says the money is "under a key only your passkey can produce" (section 1, L4).
7. **The private balance isn't hidden from "nobody".** FAR, the Confidential Intents ledger, is "a permissioned instance of the NEAR protocol operated by a small validator set" (official docs). Its operators can see balances, and so can 1Click with a session. Because every private move names your one private account, 1Click and Contri's server can also link all of a member's circle accounts (section 2.3).

---

## 1. Control of money: false until the contract is locked

### Evidence

```
view_access_key_list circles.contring.near
  -> [{ public_key: ed25519:8ikg3ZpEFprsK79HQUwWA4MBKsnWQAoCejoJDcDEyK3x, permission: FullAccess }]
view_access_key_list contring.near (the relayer)
  -> [{ public_key: ed25519:8ikg3ZpEFprsK79HQUwWA4MBKsnWQAoCejoJDcDEyK3x, permission: FullAccess }]
intents.near is_auth_by_predecessor_id_enabled(circles.contring.near) -> true
intents.near public_keys_of(circles.contring.near) -> []
intents.near mt_balance_of(circles.contring.near, USDT) -> "0"
deploy-results/secrets.json: CONTRI_DEPLOYER_KEY false, RELAYER_KEY true
deploy.log: "Creating circles.contring.near ... created, deployed and initialized: GzzRpgJ..."
```

`app/scripts/deploy.js:29` uses `CONTRI_DEPLOYER_KEY || RELAYER_KEY`. Line 71 adds the relayer's public key to the new contract account. The same key is used by `app/server/relay.js` and `app/server/keeper.js` on Vercel, and by `.github/workflows/keeper.yml` every 10 minutes. Anyone who gets that one env var can take every pot. Today that is $0 (the test circle ended), so the risk grows with the first real circle.

The contract code itself has no admin path: `owner_id` is stored and returned by `get_config`, and nothing else reads it. Once the key is deleted, Contri's team really can't move the money.

### Sentences that are false until the contract is locked

| # | Where | Exact sentence | Replace with (until locked) | After lock |
|---|---|---|---|---|
| L1 | `app/public/index.html:7` (meta description) | "A contract on NEAR holds the pot and pays each turn by itself, so nobody can run with the money." | "Save in a rotating circle with people you trust. A contract on NEAR holds the pot and pays each turn by itself." | Original is fine |
| L2 | `app/public/index.html:42` (hero) | "A contract on NEAR holds the pot and pays each person on their day, so nobody can run with the money, not even us." | "A contract on NEAR holds the pot and pays each person on their day, so no collector holds the money." | Original is fine for Contri's team |
| L3 | `app/public/index.html:103` (FAQ, Who holds the money?) | "Our team can't move it." | "Until we lock the contract, the key we deployed it with can still change its code. Locking deletes that key, and after that our team can't move the money." | "Our team can't move it: the contract's account has no keys." |
| L4 | `app/public/index.html:105` (FAQ, What if Contri disappears?) | "The contract keeps running without us. Anyone can trigger a payout once a round's deadline has passed, and your money is held in NEAR Intents under a key only your passkey can produce." | "The contract keeps running without us, and anyone can settle a round once its deadline has passed. Your money is held in NEAR Intents under keys made from your passkey, which works only on contri.ng, or from your recovery code. Write the recovery code down: if contri.ng ever goes away, it is how you reach your money with the open-source app." | Same |
| L5 | `app/public/how-it-works.html:56` | "The contract is deployed with no keys on its account, so nobody can change its code." | "The contract's account still holds the key it was deployed with. When we lock it, that key is deleted and nobody can change the code. Anyone can check the account's keys on a NEAR explorer." | "The contract's account has no keys, so nobody can change its code. Anyone can check this on a NEAR explorer." |
| L6 | `app/public/how-it-works.html:47` | "A keeper settles rounds ... anyone could do the same, it has no special rights." | "Anyone could do the same: the contract gives the keeper no special rights." (The key it signs with is the contract's key until lock; L5 covers that.) | Same |
| L7 | `app/public/js/app/screens/join.js:62` | "Nobody holds the money: a contract on NEAR keeps it and pays each round's pot by itself." | "A contract on NEAR keeps the money and pays each round's pot." | Original is fine |
| L8 | `app/public/js/app/screens/help.js:81` | "Nobody at Contri can move, freeze or take your money: your keys come from your passkey, and each pot is held by the contract." | "Contri never has your keys: they're made on this phone from your passkey, and each pot is held by the contract. What we can do is find where a payment is." | Same (also true for in-flight money: the server hands out the deposit addresses, see 2.4) |
| L9 | `app/public/terms.html:36` | "Money is held and paid out by a smart contract on the NEAR blockchain, not by Contri or any person. Contri is not a bank, lender, investment product or money transmitter, and doesn't hold your money." | "Money is held and paid out by a smart contract on the NEAR blockchain, through NEAR Intents. Until the contract is locked, Contri's deploy key can still upgrade it. Contri is not a bank, lender or investment product, and Contri's team doesn't hold your money." (Drop "money transmitter": it is a legal conclusion nobody has checked.) | Drop the "Until..." sentence |
| L10 | `app/public/terms.html:57` | "The contract's rules for a circle can't be changed once the circle has started." | "Until the contract is locked, Contri's deploy key can change its code, including a circle's rules. After it is locked, nobody can." | "Nobody can change the contract's code or a circle's rules." |
| L11 | `app/public/terms.html:44` | "Nobody, including us, can recover your key or move your money for you." | "Nobody, including us, can recover your key or move the money in your own accounts for you." | Same |
| L12 | `docs/ARCHITECTURE.md:3` | "It sits in the Contri contract's balance on NEAR Intents (`intents.near`), and only the contract can move it." | "It sits in the Contri contract's balance on NEAR Intents (`intents.near`). Once the contract account is locked (no keys), only the contract can move it. Until then its key, which is also the relayer's key, can." | "...and only the contract can move it: the contract account has no keys." |
| L13 | `docs/ARCHITECTURE.md:11` (Relayer row) | "Nothing on its own. It can't forge a member's signature or move funds, and it only relays Contri's own kinds of intents" | "It can't forge a member's signature. It relays transfers to Contri, Contri auth calls, and plain transfers between NEAR Intents accounts (how cash-outs work), for anyone who signs one. Until the contract is locked, its key is also the contract account's full-access key." | Drop the last sentence |

The README has no "nobody can move it" sentence. `deploy.yml:10` and `deploy.js:6` are correctly conditional on `--lock`.

### Before and after locking

- **Fix the contract first.** Locking freezes the code for good. The invite-deposit hole (section 3) has to be fixed before the lock.
- **Make the build checkable before the code becomes permanent.** `contract_source_metadata` has `build_info: null`, the deploy uses `cargo near build non-reproducible-wasm`, and there's no `Cargo.lock`. The deployed wasm does match the CI artifact byte for byte (sha256 `396f6b90cd19306f3aefbfc5b7e660ce3410a1d2115b365f91062f2f1797e6d8`, 99,751 bytes), which is good evidence. Still, nobody outside can rebuild it from source. Commit `Cargo.lock` and use a reproducible build.
- **Check two things after `--lock`.** `view_access_key_list` must be empty (deploy.js checks this). `intents.near public_keys_of(circles.contring.near)` must also be `[]`; it is today, and deploy.js doesn't check it. A key added there before the lock would let its holder sign intents for the contract's Intents balance after the lock.
- **The money isn't free of all trust even after lock.** `intents.near` has admin roles (`near/intents` `contracts/defuse/src/contract/mod.rs`: `DAO`, `Upgrader`, `PauseManager`, `UnrestrictedWithdrawer`, `UnrestrictedAccountLocker`), and Tether can freeze USDT. "Not even us" is fair for Contri's team after lock. Don't widen it to "nobody", and say this in the Terms (section 6).

---

## 2. Privacy

### 2.1 "No logs"

Vercel's runtime logs are on by default for every function invocation. Its docs list Request Method, Request Path, Time, Status Code, Host, Request User Agent, Search Params, Region, and Outgoing Requests (sub-requests made during the function). The "Logs from your browser" filter "works by matching your IP address and User Agent against incoming requests". Retention is 1 hour on Hobby, 1 day on Pro, and 30 days with Observability Plus (https://vercel.com/docs/logs/runtime). Request bodies aren't logged. Outgoing request URLs can include `GET 1click.../v0/status?depositAddress=...`, which ties a member's IP and browser to a deposit address for that hour or day.

| Where | Exact sentence | Replace with |
|---|---|---|
| `README.md:90` | "**No logs, no RPC fingerprinting.** The phone reads the chain through Contri's server, which keeps no logs, so no RPC provider sees one IP address looking up several circle accounts." | "**No application logs, no RPC fingerprinting.** Contri's code writes no logs and stores no requests. Vercel, which hosts it, keeps standard request logs (time, path, status, browser and IP address) for a short time. The phone reads the chain through Contri's server, so no RPC provider sees one IP address looking up several circle accounts." |
| `app/public/how-it-works.html:47` | "It can't change what you signed, and it keeps no logs." | "It can't change what you signed, and Contri's code keeps no logs of it." |
| `docs/PRIVACY.md:29` (Contri's server row) | "It keeps no logs of any of it, no names, phone numbers or IP addresses, and it can't read circle names." | "Contri's code stores none of it. Vercel, which runs the server, keeps standard request logs (time, path, status, browser and IP address, not request bodies) for a short time. It can't read circle names." Also see 2.3 for what the row leaves out. |
| `docs/PRIVACY.md:78` | "The relayer that submits signed intents keeps no logs of IP addresses or accounts." | "The relayer stores nothing, and its code writes no logs. Vercel keeps standard request logs for a short time." |
| `docs/PRIVACY.md:109` (Status) | "No personal data, no logs, no third-party requests, strict CSP" | "No personal data, no application logs, no third-party requests from the browser, strict CSP" |
| `app/public/js/app/screens/unlock.js:53` | "There is no email, phone number or password, and we keep nothing about you." | "There is no email, phone number or password, and Contri doesn't store anything about you." |
| Code comments: `app/server/relay.js:10`, `app/server/http.js:4-5`, `app/server/views.js:5`, `app/server/confidential.js:17` | "Nothing is logged or stored..." / "keeps nothing" | "Contri's code logs and stores nothing. Vercel keeps its own request logs." |

`app/public/privacy.html:50` already says "Our hosting provider, Vercel, may keep standard technical logs for security for a short time." That is the right model. Make the other places match it, and make it specific: "keeps standard request logs (time, page, browser and IP address) for a short time".

### 2.2 Linking circle accounts to wallets and to each other

Live test. I made one top-up quote through `https://contri.ng/api/swap` with a dummy account; no money moved. Then I called `GET https://1click.chaindefuser.com/v0/status?depositAddress=<address>` with no key:

```
recipient: <the circle account>   refundTo: <the circle account>   referral: contri
```

The same unauthenticated lookup on the live run's direct cash-out (deposit address and transaction removed from these notes) returns the member's own wallet and refundTo the circle account. A private top-up address and the move-home address return 404, so the private route isn't exposed this way.

Consequences:
- An exchange knows who withdrew to a deposit address, and can look up the circle account it paid.
- Anyone watching BNB Chain can check any USDT recipient address against 1Click. A non-1Click address returns 404, so this works as a filter.
- Two circles topped up directly from the same personal wallet are linked publicly.

| Where | Exact sentence | Why | Replace with |
|---|---|---|---|
| `app/public/index.html:92` | "Your other circles: Nobody. Each circle uses its own account, made from your passkey, and nothing on chain connects them." | Not true for direct top-ups from the same wallet, which is the default route. 1Click and Contri's server can link circles that share a private balance (2.3). | "Nobody looking at the chain, if you pay from your private balance or an exchange. Each circle uses its own account, made from your passkey. Topping up two circles straight from the same wallet links them." |
| `app/public/index.html:93` | "Outside it, only an account number that leads nowhere." | A direct top-up or cash-out leads to the wallet. | "Outside it, an account number. If you top up straight from a wallet, anyone who knows that wallet can follow it to this account. Paying from your private balance avoids that." |
| `app/public/how-it-works.html:44` | "Each key's account is a fresh NEAR account that has never been seen before, so your circles can't be linked to each other." | Same. | "Each key's account is a fresh NEAR account that has never been seen before, so nothing on chain links your circles to each other unless you top them up from the same wallet." |
| `app/public/privacy.html:54` | "Each circle you join uses a separate account derived from your passkey, so your circles can't be linked to each other or to you." | Same. | "Each circle you join uses a separate account derived from your passkey, so nothing on chain links your circles to each other or to you, unless you top up or cash out directly from the same wallet." |
| `docs/PRIVACY.md:19` | "Public, from an account tied to nothing else" | Same. | "Public, from an account tied to nothing else on chain when it is paid from the private balance" |
| `docs/PRIVACY.md:25` (stranger row) | "Not who they are, where their money came from or went, what the circle is called, or anyone's other circles." | Direct top-ups and cash-outs are publicly resolvable. | "Not who they are or what the circle is called. For direct top-ups and cash-outs, 1Click's public status lookup shows the wallet on the other side; for money moved through the private balance, it shows nothing." |
| `docs/PRIVACY.md:27` (exchange row) | "That you withdrew USDT to a 1Click deposit address. Not your name in Contri: there isn't one." | Verified above: the exchange can look up the circle account. | "That you withdrew USDT to a 1Click deposit address. For a direct top-up, 1Click's public status lookup shows which circle account it paid, so your exchange can tie that account to you. For a private top-up, the lookup shows nothing." |
| `docs/PRIVACY.md:57` | "Circle accounts share nothing on chain: not a key, not a funding source, not a name. Nobody can add up a member's savings or follow them from circle to circle." | A funding source is shared when one wallet tops up two circles. 1Click and Contri's server can add up savings through the shared private account. | "Circle accounts share no key and no name on chain. Unless they are topped up directly from the same wallet, nothing public ties them together. 1Click and Contri's server can see which circle accounts one private balance pays into or receives from." |
| `docs/PRIVACY.md:85` | "All of it is tied to accounts that lead nowhere." | Same. | "All of it is tied to accounts that lead nowhere unless they were topped up or cashed out directly." |
| `README.md:87` | "...so a member's circles can't be linked to each other on chain." | Same. | "...so nothing on chain links a member's circles to each other unless they top up several directly from the same wallet." |
| `app/public/js/app/screens/settings.js:41` | "Nobody looking at the blockchain can tell they belong to the same person." | Same. | "Nobody looking at the blockchain can tell they belong to the same person, unless you top up more than one straight from the same wallet." |
| `app/public/js/app/screens/circle.js:249` | "This account is used for this circle only, so it isn't linked to your other circles." | Same. | "This account is used for this circle only, so nothing on chain links it to your other circles." |
| `app/public/js/app/screens/explore.js:46` | "...by accounts that lead nowhere." | Same. | "...by accounts that don't name anyone." |

The fund screen already says it honestly (`fund.js:203`: "The public chain can link this circle to the address you send from."). The pages should match that.

### 2.3 What 1Click, Contri's server and Confidential Intents see

| Where | Exact sentence | Why | Replace with |
|---|---|---|---|
| `app/public/js/app/screens/home.js:123` | "Kept on NEAR Intents' private ledger, where nobody can see it." | FAR's operators can see it, and so can 1Click with a session. Docs: "FAR is a permissioned instance of the NEAR protocol operated by a small validator set with no public networking"; "Balances and swap details on FAR are not visible to the public." | "Kept on NEAR Intents' private ledger, which has no public explorer, so nobody looking at the public chain can see it." |
| `docs/PRIVACY.md:31` (operators row) | "Confidential balances live on NEAR's private shard, run by permissioned validators with each user's data encrypted, and deposits are screened on the way in. ... NEAR plans user-held view keys..." | "each user's data encrypted", "screened" and the view-key plan aren't in NEAR Intents' docs. Secondary press says things like "encrypted locally" and contradicts itself. The row also leaves out that the operators can see balances. | "Confidential balances live on FAR, a permissioned NEAR network run by a small validator set, with no public RPC. Its operators can see private balances and moves; the public can't. Contri relies on that the same way near.com does." |
| `docs/PRIVACY.md:28` (1Click row) | "...for a payment from it, your private account and that circle account. It doesn't know who you are." | It leaves out the important consequence. One private account per member means 1Click can group all of a member's circle accounts. Every quote is also tagged `referral: "contri"`. | Add: "Because every move names your one private account, 1Click can tell which circle accounts belong to the same member, and it sees that the swaps come from Contri." |
| `docs/PRIVACY.md:29` (server row) | "The signed intents it relays ... and, when you move money in or out of your private balance, the request that names your private account and the circle account together." | Incomplete. `wallet.js discover()` sends 5 of a member's circle accounts per `/api/rpc` request, plus balance views, every time the app opens. | "The signed intents it relays, which are public anyway; the circle accounts one phone looks up together each time the app opens; and, when you move money in or out of your private balance, the request that names your private account and the circle account together." Then the logging sentence from 2.1. |
| `app/public/js/app/private.js:4` (comment) | "Nobody looking at the public chain can see it, or link it to the member's circle accounts" | 1Click and Contri's server can link them. | "Nobody looking at the public chain can see it. 1Click and Contri's server see which circle accounts it pays." |
| `README.md:89` | "...so the public chain never links a circle account to the exchange or wallet behind it." | No address links them, but amount and timing can (PRIVACY.md:87 says so). The fund screen's "Move $X here" moves exactly the shortfall minutes after a private top-up, which is the easiest pattern to match. | "...so no address on the public chain links a circle account to the exchange or wallet behind it. Amounts and timing still can (see the limits in PRIVACY.md)." |
| `app/public/privacy.html:50` | "The app asks Contri's server to read the blockchain, to submit your signed payments, and to get deposit addresses from NEAR Intents' 1Click service. Our server does not log or store these requests, your IP address or your accounts." | Leaves out the private balance traffic. | "The app asks Contri's server to read the blockchain, to submit your signed payments, to get deposit addresses from NEAR Intents' 1Click service, and to read and move your private balance. Our code doesn't log or store these requests, your IP address or your accounts. Our hosting provider, Vercel, keeps standard request logs (time, page, browser and IP address) for a short time." |
| `app/public/privacy.html:51` | "When you top up or cash out, 1Click receives the amount, the network and the receiving address you enter. It never receives your name or contact details from us." | 1Click also gets the circle account or private account, and its status lookup is public. | "When you top up or cash out, 1Click receives the amount, the network, any address you enter and the Contri account involved. For a direct top-up or cash-out, anyone who knows the deposit address can look these up on 1Click. It never receives your name or contact details from us." |

### 2.4 The phone's check on private moves

`README.md:89`: "1Click builds the intents that move it; the phone checks each one moves exactly what the member asked before signing." `docs/PRIVACY.md:47` says the same.

The check (`lib/private.js`) is real and unit-tested: one transfer, from the private account, of USDT, of the amount asked, to `q.depositAddress`, with no call and a deadline within 7 days. But `q.depositAddress` comes from the same Contri server response. The quote's signature is dropped and never checked. So the phone can't verify where 1Click will send money from that address. The same holds for every top-up address and cash-out address the app shows.

Replace in README: "1Click builds the intents that move it. Before signing, the phone checks each one is a single transfer of the amount asked, from the member's private account, to the deposit address that came with the quote."

Add to PRIVACY.md:47: "It can't check where 1Click sends the money from that address; that relies on Contri's server passing 1Click's quote on unchanged."

### 2.5 Invite secret and the address bar

| Where | Exact sentence | Why | Replace with |
|---|---|---|---|
| `docs/PRIVACY.md:71` | "The app removes the secret from the address bar as soon as it has read it, so a screenshot or screen share of the app doesn't leak it." | `main.js:89` deliberately leaves it in place in in-app browsers (WhatsApp and similar). `circle.js:281` shows the whole link, secret included, on the circle screen while a circle is filling. The secret also stays in sessionStorage and in localStorage per slot. | "In Chrome or Safari, the app takes the secret out of the address bar as soon as it has read it, so a screenshot of the join screen doesn't show it. In an app's built-in browser it stays, so Open in browser keeps the invite working. While a circle is filling, its screen shows the whole link so members can share it." |
| `app/public/js/app/screens/circle.js:280` (share box) | "The part after # never reaches any server." | Said right where the member is about to send the whole link through WhatsApp, Telegram, SMS or email, whose servers carry it. `inviteMessage()` also puts the circle's name in plain text in the message. | "Browsers never send the part after # to Contri, but the app you share it through carries the whole link." |
| `README.md:88` | "The invite link's secret (after `#`, never sent to a server)" | Same nuance. | "The invite link's secret (after `#`, which browsers never send to a server)" |
| `app/public/js/app/main.js:84` (comment) | "so a screenshot or a shared screen doesn't give it away" | Only on the join screen. | "so a screenshot of the join screen doesn't give it away" |

Unverified: Chrome and Safari may already have saved the original `/join#...` URL to browser history (and history sync) before `replaceState` runs.

### 2.6 Sealed session

| Where | Exact sentence | Why | Replace with |
|---|---|---|---|
| `docs/PRIVACY.md:59` | "The secret is kept sealed with AES-GCM under a key the browser marks non-extractable and keeps in IndexedDB: the page can use it, but its bytes can't be read or copied off the device." | Non-extractable only blocks `exportKey` in page scripts. The key is stored in the browser profile and isn't hardware-bound. Anyone with the unlocked phone, any script running in the page, or a copy of the profile can unseal it. "As with a banking ... app" overstates it: banking apps re-check biometrics, and Contri doesn't. | "The secret is kept sealed with AES-GCM under a key the browser marks non-extractable and keeps in IndexedDB: page scripts can use it but can't export it. It isn't tied to the phone's hardware, so anyone who can use this browser can open Contri without the passkey. The phone's screen lock is what protects it." |
| `app/public/js/lib/session.js:11-12` (comment) | "nothing can read its bytes, so the stored session is useless copied off the device" | Same. | "script can use it to unseal, but can't export its bytes" |

### 2.7 Device key and Lock

`wallet.js:91-96`: `lock()` calls `forget()`, which removes `contri.session` and the IndexedDB key. `passkey.js:159-163`: `deviceSecret()` reads `contri.device-secret`, which `lock()` never removes. `unlock.js:23-27`: the "Keep my key on this device instead" button calls `useThisDevice()` and opens with no prompt.

| Where | Exact sentence | Replace with |
|---|---|---|
| `app/public/js/app/screens/settings.js:42` (shown in both modes) | "Contri stays unlocked on this device until you lock it here ... Lock it if other people use this device." | Passkey mode: keep it. Device mode: "Your key is kept in this browser, unencrypted. Locking doesn't remove it: anyone who uses this browser can open Contri again. If other people use this device, use a passkey instead." |
| `app/public/js/app/screens/settings.js:31` | "Your key is kept in this browser." | "Your key is kept in this browser, unencrypted, until the browser's data is cleared." |
| `docs/PRIVACY.md:59` | "Locking deletes both" | "Locking deletes both. A key kept on the device without a passkey stays in the browser until its data is cleared." |

Restoring from a recovery code (`unlock.js:87`) also switches a passkey user to device mode, with the secret unencrypted in localStorage. That isn't said anywhere either.

### 2.8 Features described as live that are planned

| Where | Exact sentence | Why | Replace with |
|---|---|---|---|
| `docs/PRIVACY.md:30` (members row) | "...under the nicknames members chose." | Encrypted nicknames are "planned" (PRIVACY.md:71, :112). The app shows account numbers plus names each member types on their own phone (`circle.js:228`). | "...as account numbers, plus any names you give them on your own phone." |
| `docs/PRIVACY.md:17` (track record row) | "Shown only to an organizer you choose" | Section 5 and the Status table say "planned". `get_record` is a public view, and the app never shows records. | "Kept on chain per circle account, so it isn't tied to your other circles. Showing it to an organizer is planned." |

### 2.9 Disclosures that are missing

- **Help support details** (`help.js:92`). The copied text includes circle account, deposit addresses, cash-out address and tx hash, and goes to an X DM. Add: "The details include your circle account and addresses, so sending them tells us they're yours."
- **What stays on the device** (`privacy.html:44-47`). It leaves out the sealed unlocked session, the list of top-ups and cash-outs with their addresses, private top-up quotes, and names given to members. Add: "The list of top-ups and cash-outs you made on this device, with their addresses, and any names you gave other members."
- **Clearing the browser** (`privacy.html:58`). "Clearing your browser removes everything Contri kept on your device" also deletes a device key. Add: "including a key kept without a passkey, so write down your recovery code first." Also change "Because we hold no personal data, there is nothing for us to delete" to "Contri's own code holds no personal data, so there is nothing for us to delete. Vercel's request logs expire on their own."
- **Calendar export** (`circle.js:74`). The file has the circle's name in plain text, and calendar sync sends it to Google or Apple. The code comment "nothing is sent anywhere" is true of the app only.

---

## 3. Deposits and missed payments

### 3.1 Invite deposits are chosen by the joiner

`contract/src/lib.rs:991-1002`: for invite-only circles, `valid = ed25519_verify(sig, "contri-join:<contract>:<circle>:<joiner>:<amount>", invite_key)` and `amount <= (size - 1) * contribution`. There is no lower bound beyond the transfer being non-zero. The invite key is derived from the one secret in the one link (`invite.js:25`, `fund.js:102`), so every invitee can sign any amount for themselves. The app always creates invite-only circles (`fund.js:81`), so this applies to every circle the app makes. A member using a modified client can join with 0.000001 USDT, receive an early pot, stop paying, and leave a shortfall the deposit was meant to cover.

**Recommendation (before lock):** require `amount == contribution` for invite-only joins as well, or have the organizer's app sign one invite per person. Without that, per-person deposits can't work.

| Where | Exact sentence | Replace with (if not fixed) |
|---|---|---|
| `docs/PRIVACY.md:64` | "The invite also sets the deposit, so an organizer can privately ask less of someone they trust and more of a stranger." | "The invite's signature also covers the deposit, but everyone with the link holds the same invite key, so it sets nothing per person yet. The app always signs for one contribution." |
| `docs/ARCHITECTURE.md:100` | "In an invite-only circle the organizer sets each person's deposit in their invite: less for someone they trust, or more for a stranger, up to every round but the member's own." | "In an invite-only circle the deposit is whatever the invite key signs, up to every round but the member's own. Everyone with the link holds that key, so the app's one-contribution deposit is a convention the contract can't enforce yet." |
| `docs/METHODS.md:113` | "In an invite-only circle the invite sets it, up to every round but the member's own: less for someone the organizer trusts, more for a stranger." | "In an invite-only circle the invite key's signature sets it, up to every round but the member's own. Every link holder has the invite key, so per-person deposits need per-person invite keys, which the app doesn't make yet." |
| `docs/PRIVACY.md:104` (Status) | "Invite-only circles, per-person deposits: In the contract, unit-tested" | "Invite-only circles: in the contract, unit-tested. Per-person deposits: in the contract only, and not enforceable while one link serves everyone." |
| `contract/src/lib.rs:386-389` (comment) | "The organizer chooses each person's deposit privately, in the app" | "The invite key's holder chooses the deposit. The app doesn't offer per-person invites." |

### 3.2 "The pot still pays in full"

`internal_settle` takes `min(deposit, contribution)` from the member's deposit, then from backing, and records any shortfall. With a one-contribution deposit, a member's second missed round isn't covered.

| Where | Exact sentence | Replace with |
|---|---|---|
| `app/public/index.html:78` | "If someone misses a round, it comes out of their deposit and the pot still pays in full." | "If someone misses a round, it comes out of their deposit and the pot still pays in full. A second missed round isn't covered, and that pot is short." |
| `app/public/how-it-works.html:36` | "...missed contributions come out of the late members' deposits and the pot pays in full." | "...missed contributions come out of the late members' deposits, and the pot pays in full while those deposits last." |
| `app/public/js/app/screens/home.js:23` | "You missed this round. Your deposit covers it when the round is settled." | Shown even when the deposit is already used up. Make it conditional on `m.deposit >= contribution`. Otherwise: "You missed this round and your deposit is used up, so this round's pot will be short." |
| `app/public/js/app/screens/create.js:39` | "Everyone puts down $X as a deposit when they join, which comes back at the end." | "...which comes back at the end, less any payment it covered." |

### 3.3 Inconsistent deposit cap

`docs/ARCHITECTURE.md:88`: "the deposit is the transferred amount, at most one contribution". The contract and every other doc say up to (size - 1) contributions. Replace with: "the deposit is the transferred amount, up to every round but the joiner's own".

---

## 4. Feature claims: implemented and reachable?

| Claim (README "How NEAR is used" and docs) | Contract | App UI | Tested | Verdict |
|---|---|---|---|---|
| NEAR Intents money layer, `mt_on_transfer`, payouts by `mt_transfer` | Yes | Yes | Unit, sandbox e2e, mainnet run (8 tx verified) | True |
| Passkey-derived keys, NEP-413, relayer simulate then execute | n/a | Yes | Unit, e2e, mainnet | True |
| AuthCall: leave, list/unlist, cancel | Yes | Yes (`circle.js`) | Unit | True |
| AuthCall: "claiming a failed transfer" (`claim_credit`) | Yes | **No**: `actions().claimCredit` is never used, and `get_credit` is never read | Unit | Overstated |
| 1Click top-ups and cash-outs | n/a | Yes | Live dry quotes, mainnet run | True |
| Confidential Intents private balance | n/a | Yes | Unit, live-check, mainnet run (README) | True; privacy wording needs 2.3 |
| Fair random draws | Yes (`env::random_seed_array` at fill) | Yes (create screen) | Unit | True. Validators can bias the seed in theory; nobody else can pick it |
| Seats as live NFTs (NEP-171/177/181 views, events, SVG) | Yes | Yes (seat image on the circle screen) | Unit | True (views only; there is no `nft_transfer`, as the docs say) |
| Seat sales | Yes | Yes | Unit, sandbox e2e | True |
| Community backing from DAOs (Trezu/Sputnik) | Yes | **No** (no backing shown or offered in the app) | Unit only. No e2e (`e2e.rs` has no `back:`), and the Trezu template hasn't been run against a real DAO | Overstated |
| Deposit refill (`refill:<circle>`) | Yes | **No** | Unit | Contract only |
| Per-person invite deposits | Yes, but unenforceable (3.1) | **No** | Unit | False as described |
| Private track record | Records kept on chain | **No** | n/a | Planned (PRIVACY.md:17 says otherwise, see 2.8) |
| Encrypted nicknames | n/a | **No** (local names only) | n/a | Planned (PRIVACY.md:30 says otherwise, see 2.8) |
| NEP-330 source metadata | Yes | n/a | Unit | True, but `standards` lists only nep297 and nep330 (not 171/177/181/245), and `build_info` is null |
| Embedded ABI | Yes (`__contract_abi` returns 3,493 bytes of zstd on mainnet) | n/a | CI drift check | True |

Replacements:

- `README.md:98`: "**`AuthCall` intents** for leaving a circle, listing or unlisting a turn, and cancelling. Claiming a failed transfer (`claim_credit`) is in the contract; the app doesn't offer it yet."
- `README.md:103`: "**Community backing (in the contract).** Any account can back a circle with `mt_transfer_call` and `back:<circle>`, for example a Sputnik DAO proposal (template in [integrations/trezu](integrations/trezu)). It is unit-tested; the app doesn't show backing yet, and the template hasn't been run against a live DAO."
- `docs/ARCHITECTURE.md:100`: "A member can refill their deposit with `refill:<circle>`." Change to: "A member can refill their deposit with `refill:<circle>` (in the contract; not in the app yet)."
- `DEMO.md:3`: "Written before any code. If a feature is not in this script, it is not in the first build." The build has the private balance, random draws, DAO backing and seat NFTs. Replace with: "Written before any code. The first build added more than this script shows: random turn order, the private balance and community backing."
- `integrations/trezu/back-a-contri-circle.json:18`: "The circle number shown on the circle's page in Contri". The page shows the name, not the number. Replace with: "The circle's number, from its address in Contri (/app#/c/<number>)".
- `README.md:48`: "every circle on the contract, read straight from the chain". It goes through Contri's read proxy, and closed circles are deleted. Replace with: "every open, running or finished circle on the contract, read from the chain through Contri's server."

---

## 5. Numbers

### Tests (counted)

| Suite | Count | Source |
|---|---|---|
| `contract/src/tests.rs` | 68 `#[test]` | grep |
| `contract/src/json_tests.rs` | 4 `#[test]` (one runs 20,000 seeded random and mutated documents against serde_json) | grep, read |
| Contract unit total | **72**: matches README:62 | CI `ci-results/test.log`: "72 passed; 0 failed" |
| `contract/sandbox/tests/e2e.rs` | **5** `#[tokio::test]`. README:69-72 lists 4 and leaves out `the_deploy_script_creates_upgrades_and_locks_the_contract` | CI `sandbox-results/e2e.log`: "5 passed" |
| `app/test/lib.test.js` / `private.test.js` / `server.test.js` / `ui.test.js` | 14 / 9 / 7 / 8 = **38** | I ran them locally: 38 pass, 0 fail |

Cargo couldn't run here (no crates.io access); CI's log is the evidence for the 72. `npm run check` says it "type-checks every JS file", but `jsconfig.json` includes `.js` only, so the `.mjs` scripts aren't checked. Small point.

### Contract size and storage

- Deployed wasm: **99,751 bytes** (under 100 KB). Byte-identical to CI's `ci-out/contri.wasm`; `size.json` says `raw_bytes: 99751`.
- `docs/FEES.md:49` says "**99.8 KB** | **1.00 NEAR** (99,827 bytes)". That number is stale. Replace with: "**99.8 KB** | **1.00 NEAR** (99,751 bytes deployed)".
- The contract account was funded with 1.0775 NEAR. It holds 101,007 bytes now (code plus state), which locks about 1.01 NEAR.
- `docs/FEES.md:53`: "Storage is locked, not spent: it comes back when the data or the contract is deleted." Once locked, the account can't be deleted and its balance can't be withdrawn. NEAR freed by `close_circle` returns to the contract account, not to anyone. Replace with: "Storage is locked, not spent. Freed storage goes back to the contract account's balance; once the account is locked, nobody can withdraw it."

### Fees

- **"Contri takes no fee"**: true. Every quote sends `referral: "contri"` and no `appFees` (`oneclick.js:84,123`, `confidential.js:121,167,225`). The one app fee 1Click attaches (`fee: 1`, i.e. 1 bp, to `5880ad2b...`) also appears on an unauthenticated quote with no referral, so it is 1Click's own fee. That matches NEAR Intents' published 0.01% for stablecoin routes with an API key (`ONECLICK_API_KEY` is set in production).
- Live dry quotes on 5 Nov 2026:
  - BSC cash-out of $3 and $10: fee $0.01, 13 s
  - Solana cash-out of $10: $0.01, 7 s
  - Tron cash-out of $10: **$0.87**, 65 s
  - Private cash-out of $3 to BSC: $0.02
  - Private balance to a circle: $0.00, 10 s
  - BSC top-up: about 35 s
  So "a few cents on BNB Chain or Solana", "about 13 seconds" and "free, about ten seconds" all hold.
- The app asks members to send 0.5% extra, rounded up to the cent (`toSend`). Under FLEX_INPUT the extra lands in the account. That's fine, but it isn't explained anywhere except "Sending more is fine".

| Where | Exact sentence | Why | Replace with |
|---|---|---|---|
| `app/public/index.html:104` | "Moving money in and out goes through NEAR Intents, which shows its network fee before you send" | The top-up screen shows only "Send X" and no fee or arrival amount (`depositDetails` ignores `q.receive`). Cash-out shows the fee only if you tap "See what arrives"; "Move to private balance" shows none. | "Moving money in and out goes through NEAR Intents' 1Click, whose fees are usually a few cents on BNB Chain or Solana. The cash-out screen shows them when you tap See what arrives." (Better still: show `receive` on the top-up screen, and keep the sentence.) |
| `app/public/terms.html:51` | "...are set by NEAR Intents and the networks you use, and are shown before you send." | Same. | "...are set by NEAR Intents and the networks you use. The app asks you to send a little more than you need so fees don't leave you short; the extra stays in your account." |
| `docs/FEES.md:26` | "...but the app warns that cashing out to Tron costs about 1.56 USDT." | No such warning exists. The cash-out picker shows only network names, and today's fee is 0.87. | "Tron works for top-ups of about 2.56 USDT or more. Cashing out to Tron costs more than other networks (0.87 USDT on 5 Nov 2026); the cash-out screen shows the fee when you tap See what arrives." |
| `docs/FEES.md:25` | "...and the app recommends BNB Chain or Solana." | Only the top-up list does this, by ordering and notes. | "...and the app lists BNB Chain and Solana first when you top up." |

### Timings and costs

- README "about $6 in, nearly all of it back; 10 minutes": true. Rounds can be paid back to back, and the live run's payments took about 6 minutes.
- "usually within a couple of minutes" (index step 2): true for BSC, Solana and Tron by `timeEstimate`.
- FEES gas figures ("10 Tgas costs about 0.001 NEAR"): true at 100M yocto per gas.

---

## 6. Terms and legal

Overstated promises are in section 1 (L9 to L11). Missing for a money app:

1. **Upgrade key.** Until locked, Contri's deploy key can change the contract. (L9 and L10 cover this.)
2. **Third parties that can stop or move money.** "Your money is held through NEAR Intents (`intents.near`), whose operators can pause or upgrade it and lock accounts, and in USDT, which Tether can freeze. The private balance runs on a permissioned network run by NEAR Intents' operators. 1Click may refund or hold a swap." (Roles verified in the `near/intents` source.)
3. **Members can default.** "A deposit covers one missed payment. If a member misses more, later pots are short, and Contri can't make anyone pay." (The current text, "it can't make a member pay every round", is close; add the short-pot consequence.)
4. **No reversals.** "Blockchain payments can't be undone. Contri can't refund or reverse a payment."
5. **Losing access.** "If you lose your passkey and your recovery code, or clear a browser that kept your key without a passkey, nobody can get your money back. Passkeys work only on contri.ng: keep your recovery code in case the site goes away."
6. **No protection.** "Your money isn't insured or covered by any deposit protection scheme, and Contri isn't licensed or regulated." (Replace the unverified "not a ... money transmitter" with this.)
7. **Service may stop.** "Contri's site, relayer and keeper may stop working. The contract and NEAR Intents keep your money, and the open-source app and your recovery code can still reach it."
8. **Governing law and disputes.** There is none. Add, for example: "These terms are governed by the laws of Nigeria."
9. **Taxes.** "You are responsible for any taxes on your savings."

`terms.html:43` ("18 or older and allowed to use stablecoins") and `terms.html:39` ("Only put in money you can afford to lose, and start with small amounts") are good and should stay.

---

## 7. Other in-app and page copy

| Where | Exact sentence | Why | Replace with |
|---|---|---|---|
| `app/public/index.html:68` | "Only people with the link can see or join the circle." | Live circles shows every circle (amounts, members, payouts) to everyone. Only the name is hidden. | "Only people with the link can join the circle or read its name." |
| `app/public/how-it-works.html:37` | "Turn order is either the order people joined, or drawn at random ... so the organizer can't pick the best turn for themselves." | In join order the organizer always gets turn 1 (`create.js:52` says so). | "Turn order is either the order people joined, with the organizer first, or drawn at random by the contract from NEAR's block randomness once the circle is full, so nobody picks it." |
| `app/public/index.html:107` (FAQ) | "It shows every top-up and cash-out you've made and where each one is. Anything that can't go through is refunded to your own account, never to anyone else." | The list is kept in this browser's localStorage only (`help.js` says "on this phone"). Coins sent on the wrong network aren't refunded (the Terms say so). | "It shows every top-up and cash-out made from this phone and where each one is. A swap 1Click can't complete is refunded to your own circle account or private balance, never to anyone else. Coins sent on the wrong network may not come back." |
| `app/public/index.html:106` (FAQ) | "If your passkey is ever deleted, the recovery code you wrote down from Your key brings everything back." | Writing it down is optional for passkey users. | "If your passkey is ever deleted, the recovery code from Your key brings everything back, if you wrote it down." (Edge case: a new phone stops looking after three empty account slots in a row, so circles in later slots can be missed.) |
| `app/public/js/app/screens/cashout.js:72` | "Your address is sent only to 1Click, which delivers the money there." | It passes through Contri's server, and 1Click's status lookup makes it public along with the circle account. | "Your address goes through Contri's server to 1Click, which delivers the money there. Anyone who knows the deposit address can see it on 1Click." |
| `app/public/how-it-works.html:35` | "Members join by paying a deposit of one contribution." | True for the app only (3.1). | Keep once 3.1 is fixed in the contract. |
| `README.md:48` | "Every action is a NEP-413 intent signed on the phone and submitted by Contri's relayer" | Private-balance moves are submitted to 1Click by Contri's server, not by the relayer. | "Every circle action is a NEP-413 intent signed on the phone and submitted by Contri's relayer" |

---

## 8. Consistency: the same fact stated differently

| Fact | Says A | Says B | Truth |
|---|---|---|---|
| Contract keys | how-it-works:56 "deployed with no keys" | ARCHITECTURE:10 "no keys on its account once locked" | One FullAccess key (the relayer's) |
| Logs | README:90, how-it-works:47, PRIVACY.md:29/78 "keeps no logs" | privacy.html:50 "Vercel may keep standard technical logs" | Code: none. Vercel: request logs |
| Real-money run | README:22-35 done 5 Nov | PRIVACY.md:111 "pending"; ARCHITECTURE:58 "Being tested ... quotes need a 1Click partner key"; ARCHITECTURE:127-128 "To test" | Done 5 Nov (8 tx verified). Replace ARCHITECTURE:58 with "The same legs also run through Confidential Intents for the private balance; see PRIVACY.md." Mark ARCHITECTURE:127-128 and PRIVACY.md:111 "Done on 5 November 2026 (transactions in the README)." |
| Deposit cap | ARCHITECTURE:88 "at most one contribution" | ARCHITECTURE:100, METHODS:113, contract: up to every round but own | (size - 1) x contribution |
| Nicknames | PRIVACY.md:30 present tense | PRIVACY.md:71/112 planned; app: local names | Planned |
| Track record | PRIVACY.md:17 "Shown only to an organizer you choose" | PRIVACY.md:73/112 planned | Planned |
| Contract size | FEES.md:49 99,827 bytes | CI size.json and mainnet: 99,751 | 99,751 |
| Fees shown | index FAQ and Terms "shown before you send" | Top-up screen shows none | Shown only on request, at cash-out |
| Tron cash-out | FEES.md 1.56 USDT, "the app warns" | App: "higher fees", no amount | 0.87 today, no warning |
| Who sees a circle | index:68 "Only people with the link can see ... the circle" | Live circles shows all circles | Only the name is private |
| Pot after a miss | index:78 "the pot still pays in full" | ARCHITECTURE:100 "the pot is short"; Terms "can't make a member pay every round" | Full only while the deposit lasts |
| Lock on device | settings.js:42 "Lock it if other people use this device" | Device mode: the key stays | Lock protects passkey users only |
| Help history | index FAQ "every top-up and cash-out you've made" | help.js "you make on this phone" | This browser only |
| Keeper rights | how-it-works:47 "no special rights" | Its key is the contract's full-access key | No rights in the contract; the key can upgrade it until lock |
| Demo scope | DEMO.md:3 "not in this script, not in the first build" | README feature list | The build has more |

---

## 9. Claims verified as true

- **Mainnet run.** All 8 README transactions exist and match the table: create plus $1 deposit, join, round payments, the $2 pot in the same tx as the last payment (rounds 1 and 2), and the `release_deposits` returning both deposits. The contract's USDT balance on `intents.near` is now `"0"`. Circle 0 is `Finished` with zero deposits.
- **Deployed code.** The deployed wasm is the CI build (sha256 `396f6b90...`, 99,751 bytes, under 100 KB). The embedded ABI is served by `__contract_abi`. The contract has no owner or admin method.
- **Tests.** 72 contract unit tests (CI log), including a differential JSON test of 20,000 seeded cases against serde_json. 5 sandbox e2e tests pass in CI. 38 app tests pass (run here).
- **No Contri fee.** No `appFees` or referral fee from Contri; the 1 bp on quotes is 1Click's. Live fees on BNB Chain and Solana are $0.01 to $0.02.
- **Browser hygiene.** Live headers carry the strict CSP (`default-src 'none'`, all others `'self'`), no-referrer, nosniff, HSTS and COOP/CORP. The browser loads no third-party scripts, fonts or trackers, and the fonts are self-hosted. The server code has no `console.*`.
- **Keys and accounts.** Keys come from the passkey PRF through HKDF, one per circle (`contri/circle/<contract>/<n>`), plus a separate private account (`contri/vault/<contract>`). The PRF secret isn't sent to the server.
- **Invites.** The secret sits in the URL fragment, and browsers don't send it. The circle name is AES-GCM encrypted (with AAD) before it goes on chain. The contract checks `ed25519_verify` on a join message that names the joiner, so a signature can't be reused by someone else.
- **Relayer.** It checks the signature, the deadline (30 minutes at most), the intent kinds and the gas limit, then runs `simulate_intents`, then `execute_intents` at 300 Tgas. It refuses anything else before spending gas (unit-tested).
- **Phone check on private moves.** It covers signer, token, amount, single transfer, no call, deadline within 7 days and receiver equal to the quoted address, and it is unit-tested. The server repeats the check without the amount.
- **Private route on 1Click.** Private top-up and move-home deposit addresses aren't resolvable on 1Click's public status endpoint (404).
- **Circle rules in the contract.** Random draws use `env::random_seed_array` when the circle fills. Seats are tokens with NEP-171/177/181 views and NEP-171 events, and the SVG is drawn from live state. Fill-by is 14 days, after which anyone can cancel. Members can leave before the start. `close_circle` runs only after everything is paid back.
- **Staying unlocked.** Tested on each deploy in Chromium, WebKit and Firefox, on phone and desktop profiles (`web-results/live-sessions.txt`).
- **Keeper.** It runs every 10 minutes on GitHub Actions, daily on Vercel cron, and on demand from the app. `settle_round`, `pay_out` and `release_deposits` are callable by anyone.
- **Gas.** The relayer pays it. Members never hold NEAR.
- **Terms basics.** "Not a bank ... doesn't lend, pay interest or invest" is accurate. The age, risk ("afford to lose") and wrong-network warnings are present.

---

## 10. Evidence log

```
# keys
POST rpc.mainnet.fastnear.com query view_access_key_list circles.contring.near
  keys: [8ikg3Zp... FullAccess, nonce 223124249000000]
POST ... view_access_key_list contring.near
  keys: [8ikg3Zp... FullAccess]
view_account circles.contring.near: amount 1.0775 NEAR, storage_usage 101007, code_hash 4sCnCi9L...
contract_source_metadata: {"version":"0.1.0","link":"https://github.com/ohjay-official/contri","standards":[nep297, nep330],"build_info":null}

# wasm
view_code circles.contring.near -> 99,751 bytes, sha256 396f6b90cd19...e6d8 (same as origin/ci-results:ci-out/contri.wasm)

# 1Click public status (no API key)
Contri top-up quote 0x5266...1C6c -> recipient = account, refundTo = account, referral = contri, appFees [{recipient 5880ad2b..., fee 1}]
Unauthenticated quote, no referral -> appFees [{recipient 5880ad2b..., fee 1}]   (so the 1 bp is 1Click's)
Live-run cash-out [removed] -> SUCCESS, recipient [the member's wallet, removed], refundTo [circle account], referral contri
Live-run move-home [removed] -> 404
Contri private top-up quote 0x9632...066D -> 404

# live dry quotes via https://contri.ng/api/swap
cashout bsc $3 -> receive 2.98, fee 0.01, 13 s;  bsc $10 -> 9.98, 0.01
cashout sol $10 -> 9.98, 0.01, 7 s;  tron $10 -> 9.12, 0.87, 65 s
pmove to circle $3 -> 3.00, fee 0.00, 10 s;  pmove to bsc $3 -> 2.98, 0.02

# Vercel defaults: https://vercel.com/docs/logs/runtime (retention: Hobby 1 h, Pro 1 day; fields listed in 2.1)
# Confidential Intents: https://docs.near-intents.org/integration/market-makers/confidential-intents
# 1Click fees: https://docs.near-intents.org/resources/fees
# NEAR Intents roles: github.com/near/intents contracts/defuse/src/contract/mod.rs (enum Role)
```

Side effects of this audit: two non-dry 1Click quotes were requested through contri.ng (one top-up, one private top-up) and one directly from 1Click, all for dummy accounts. No money moved, and the addresses expire on their own. Nothing in the repo was changed.
