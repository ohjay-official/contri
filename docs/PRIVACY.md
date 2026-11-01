# Privacy

An ajo holds sensitive things: how much people save, who missed a payment, who needed the pot early. On a normal onchain savings circle all of that sits next to your wallet address, and that address leads to your exchange account and your other money.

Contri keeps **who you are**, **where your money comes from and goes**, and **what your circle is** private. The one thing it keeps public is what has to be public for nobody to cheat: the contract's rules and the payments they act on, made by accounts that lead nowhere.

## What a stranger can see

| | Typical onchain savings circle | Contri |
| --- | --- | --- |
| Your name, phone number, email | Often in the app's database | Never collected |
| The circle's name and members' names | Public, or in the app's database | Encrypted. The key is only in the invite link |
| The exchange account or wallet you paid from | Traceable from the chain | Hidden: top-ups land in a confidential balance |
| Where your payout went | Traceable from the chain | Hidden: cash-outs leave from a confidential balance |
| Your other circles and total savings | Linked by your wallet address | Each circle uses its own account |
| Your track record | Public and tied to your wallet | Shown only to an organizer you choose |
| Who can join | Anyone who finds the circle | Only people with the invite link |
| That an account paid 5 USDT into circle #3 in round 2 | Public | Public, from an account tied to nothing else |

## The layers

### 1. Confidential money in and out
Top-ups and cash-outs go through **Confidential Intents**, NEAR Intents' private execution layer on a private shard.

- **Top up:** the 1Click quote uses `recipientType: CONFIDENTIAL_INTENTS`, so money from an exchange withdrawal or a wallet lands in the member's confidential balance. The public chain shows a deposit to a 1Click address and nothing that links it to the member.
- **Contribute:** the member moves the contribution from their confidential balance to their circle account (`depositType: CONFIDENTIAL_INTENTS`). Publicly this shows an anonymous sender. The contribution itself is the usual signed `Transfer` to the contract.
- **Cash out:** the payout moves into the member's confidential balance, then out to any chain. The explorer shows an anonymous sender.

Confidential operations need a user session with 1Click. The member gets it by signing an empty intent with their passkey (`POST /v0/auth/authenticate`).

### 2. One account per circle
Each circle uses its own NEAR Intents account, derived from a key the member's passkey controls. Two circles of the same person share nothing on chain, so nobody can add up someone's savings or follow them from circle to circle.

### 3. Invite-only circles (in the contract)
The organizer's app makes an ed25519 **invite key**. Its public half is stored with the circle; its secret half lives only in the invite link. To join, the joiner's app signs `contri-join:<contract>:<circle>:<joiner account>` with the invite key, and the contract checks the signature (`env::ed25519_verify`) before taking the seat. Because the signature names the joiner, a signature seen on chain can't be reused by anyone else. Without a valid invite, the deposit is refunded.

### 4. End-to-end encrypted circle details
The invite link carries a secret after `#`, which browsers never send to any server. The app derives two keys from it: the invite signing key and an AES-GCM key. The AES-GCM key encrypts:

- the circle's name, stored on chain as ciphertext (the contract stores names as given, up to 256 bytes, and seat NFTs never show them);
- members' display names and notes, stored as ciphertext by the relayer.

Only people with the link can read them. That includes us: we never see them.

### 5. Private track record
A member's record (circles completed, payments missed) lives on chain per account. Since every circle has its own account, a member proves their history only when they choose to. Their app signs a challenge with each past circle account and sends the proofs, encrypted, to the organizer of the circle they want to join. The organizer's app checks those accounts' records on chain. Nothing public ever links the accounts together.

### 6. Nothing personal on our side
- No phone numbers, emails or names are collected.
- The relayer that submits signed intents keeps no logs of IP addresses or accounts.
- No analytics or tracking scripts.

The code is open source, so all of this can be checked.

## What stays public, and why
The contract replaces the person who used to hold the money, and anyone can check it does that honestly because its rules and state are public: circle ids, contribution amounts, schedules, the member accounts in each seat, who has paid this round, payouts, deposits, seat listings and sales. All of it is tied to accounts that lead nowhere.

Timing can still hint at links. If someone moves exactly one contribution out of their confidential balance a second before contributing, the two transactions sit side by side. The app reduces this by moving money ahead of time and in round amounts.

## What we chose not to hide
We looked at keeping the pot itself in a confidential balance. A contract can own one through NEAR Chain Signatures, the way Trezu runs confidential DAO treasuries. It would not hide more, because the contract's public rules already show who is paid in which round. Hiding the circle's state too would mean running the rules in a trusted enclave and trusting its hardware instead of a public contract. That is a possible next step ("sealed circles"), not part of this version.

## Status

| Layer | Status |
| --- | --- |
| Invite-only circles | In the contract, unit-tested (`invite_only_circle_needs_a_signed_invite`) |
| Encrypted names, none in NFT metadata | In the contract, unit-tested |
| Confidential top-up, contribute, cash-out | To verify in the first $1 mainnet test (passkey sign-in to 1Click's confidential API) |
| One account per circle | App, in progress |
| End-to-end encrypted details | App, in progress |
| Private track record | App, in progress |
| No personal data | App and relayer, in progress |
