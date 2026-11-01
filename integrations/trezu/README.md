# Back a circle from a Trezu treasury

A cooperative, church, association or employer that keeps its funds in a [Trezu](https://github.com/NEAR-DevHub/trezu) treasury (a Sputnik DAO) can put money behind its members' savings circles with one proposal.

1. In Trezu, open **Custom templates**, choose **Code**, and paste [`back-a-contri-circle.json`](back-a-contri-circle.json). Replace `CONTRI_CONTRACT_ID` with the contract id in the main README. Creating a template needs the DAO's `ChangePolicy` permission.
2. Any member fills the form with the circle number and the amount, and files the proposal.
3. When the council approves it, the DAO calls `mt_transfer_call` on `intents.near` from its own NEAR Intents balance. NEAR Intents moves the USDT to Contri and calls `mt_on_transfer` with `back:<circle>`.

What the backing does:

- When a member misses a payment, Contri takes it from their deposit first, then from the backing.
- When the circle ends or is cancelled, whatever backing is left is split back between the backers in proportion to what each put in, and `release_deposits` sends it.
- Each circle takes up to 10 backers, each putting in at least one contribution.

The treasury needs USDT in its NEAR Intents balance first. Trezu treasuries hold their assets there.
