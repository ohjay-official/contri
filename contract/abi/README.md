# Contract ABI

`contri_abi.json` describes every contract method, its arguments and its result types in the [NEAR ABI](https://github.com/near/abi) format. `contri_abi.zst` is the same file minified and zstd-compressed. The contract embeds it and returns it from `__contract_abi`, the way cargo-near embeds an ABI, so NEAR tools and explorers can read it.

Why it is generated from a separate crate: the contract reads and writes its JSON by hand to stay under 100 KB (see `docs/FEES.md`), so near-sdk cannot see its types. `contract/interface` declares the same methods with typed signatures, and CI runs `cargo near abi` on it.

How the two are kept in step:

- Unit tests parse the output of every view and call that returns a value into the interface's types, which reject missing or unknown fields (`views_match_the_typed_interface` in `contract/src/tests.rs`).
- CI compares the function names in the ABI with the functions the built wasm exports (`scripts/abi.py exports`).
- CI regenerates the ABI on every push and fails if this committed copy is out of date.

To update after changing a method: change `contract/interface/src/lib.rs`, push, and copy `contri_abi.json` and `contri_abi.zst` from the `ci-results` branch into this folder.
