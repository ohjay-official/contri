# Contri

Ajo without the collector. Savings circles on NEAR.

Contri runs a rotating savings circle (ajo, esusu, susu, tanda, chit fund) where a NEAR smart contract holds the pot instead of a person. Members sign in with a phone passkey, pay from the chain or exchange where their dollars already sit, and the contract pays each turn automatically. A member who needs cash early can buy an earlier turn from someone willing to wait.

It is private by design. Money comes in and goes out through Confidential Intents, so nobody can trace a member's savings to their exchange account or wallet. Circles are invite-only, their names and members' names are end-to-end encrypted, each circle uses its own account, and Contri collects no personal data. See [docs/PRIVACY.md](docs/PRIVACY.md).

Built for NEAR HACKATHON (Nov 1-14, 2026). Tracks: NFTs That Do Something, Real-World Money, Privacy & Private AI, Open Innovation.

## How to test

> Status: in development. This section is written first and filled in as each mode ships. Every step below will be a "do X, see Y" step.

### 1. Watch mode (no setup)
Open the live demo and pick a finished circle. Every contribution and payout links to its transaction on the NEAR Intents explorer.

### 2. No-funds mode (no wallet, no money)
Create a circle with simulated members and step through the rounds. Quotes come from the real NEAR Intents 1Click API with `dry: true`, so no money moves.

### 3. Live mode ($0.50, your own wallet)
Join the public practice circle with a passkey, top up $0.50 from any supported chain, contribute, and receive a real payout.

## What it does

1. An organizer creates a circle: amount per turn, number of members, how often it pays out.
2. Members join by link and sign in with a passkey. No seed phrase, no NEAR account, no gas token.
3. Each member puts down a deposit worth one contribution, which covers them if they miss a payment.
4. Each round, members top up from any chain or exchange through NEAR Intents and confirm their contribution with their passkey.
5. When everyone has paid, or the round deadline passes, the contract pays that round's member.
6. Turns are seats. A member can list their seat and another member can buy it.
7. When the circle ends, deposits go back and every member who paid on time gets a completed-circle record.

## How NEAR is used

- **NEAR Intents accounts from passkeys and wallets.** A member's Intents account is derived from their passkey or wallet public key, so members never create a NEAR account.
- **1Click API.** Members top up from Tron, BNB Chain, Ethereum, Solana and other supported chains, including straight from an exchange withdrawal.
- **Signed intents with notification.** A contribution is a `Transfer` intent to the Contri contract that triggers `mt_on_transfer`, so the contract knows exactly who paid without trusting a server.
- **`AuthCall` intents.** Creating a circle and listing a seat are authenticated calls from the member's own signature. Members with a NEAR account can also call these directly.
- **Contract-held pot.** The pot sits in the Contri contract's NEAR Intents balance. Only the contract can move it, and only to members in the agreed order.
- **Confidential Intents.** Top-ups land in the member's confidential balance and cash-outs leave from it, so the public chain never links a member to their exchange account or wallet.
- **Invite-only circles.** Joining needs the invite key's ed25519 signature over the joiner's account, checked by the contract.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full money path, [docs/METHODS.md](docs/METHODS.md) for every contract method, view and event, and [DEMO.md](DEMO.md) for the 60-second demo script.

## License

MIT
