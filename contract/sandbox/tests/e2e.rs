//! Contri end to end, against the real NEAR Intents contract on a local NEAR
//! sandbox. Money moves exactly as on mainnet: a NEP-141 token stands in for
//! USDT, members hold it inside NEAR Intents, and every payment reaches Contri
//! through Intents (`mt_transfer_call`, or a signed `Transfer` intent with a
//! notification). Payouts leave Contri through Intents' `mt_transfer`.
//!
//! Run with INTENTS_WASM, FT_WASM and CONTRI_WASM set (see the sandbox workflow).

use anyhow::{bail, ensure, Result};
use base64::Engine as _;
use ed25519_dalek::{Signer as _, SigningKey};
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// 5 USDT (6 decimals).
const C: u128 = 5_000_000;
const USDT: u128 = 1_000_000;
const PERIOD_SECS: u64 = 60;

struct Env {
    worker: Worker<Sandbox>,
    root: Account,
    usdt: Contract,
    intents: Contract,
    contri: Contract,
    token: String,
}

fn wasm(var: &str) -> Vec<u8> {
    let path = std::env::var(var).unwrap_or_else(|_| panic!("set {var} to the path of the wasm file"));
    std::fs::read(&path).unwrap_or_else(|e| panic!("can't read {path}: {e}"))
}

fn check(what: &str, r: &ExecutionFinalResult) -> Result<()> {
    let logs: Vec<&str> = r.logs();
    println!("{what}: {} Tgas", r.total_gas_burnt.as_gas() / 1_000_000_000_000);
    for l in logs.iter().filter(|l| l.contains("contri")) {
        println!("    {l}");
    }
    if !r.is_success() || !r.receipt_failures().is_empty() {
        bail!("{what} failed: {:#?}", r.receipt_failures());
    }
    Ok(())
}

async fn account(root: &Account, name: &str) -> Result<Account> {
    Ok(root
        .create_subaccount(name)
        .initial_balance(NearToken::from_near(20))
        .transact()
        .await?
        .into_result()?)
}

async fn setup() -> Result<Env> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;

    let usdt = account(&root, "usdt").await?.deploy(&wasm("FT_WASM")).await?.into_result()?;
    let r = usdt
        .call("new_default_meta")
        .args_json(json!({"owner_id": usdt.id(), "total_supply": "1000000000000000"}))
        .transact()
        .await?;
    check("token init", &r)?;

    let intents = account(&root, "intents").await?.deploy(&wasm("INTENTS_WASM")).await?.into_result()?;
    let r = intents
        .call("new")
        .args_json(json!({"config": {
            "wnear_id": format!("wrap.{}", root.id()),
            "fees": {"fee": 0, "fee_collector": root.id()},
            "roles": {}
        }}))
        .max_gas()
        .transact()
        .await?;
    check("intents init", &r)?;
    let r = usdt
        .call("storage_deposit")
        .args_json(json!({"account_id": intents.id()}))
        .deposit(NearToken::from_millinear(10))
        .transact()
        .await?;
    check("intents registers on the token", &r)?;

    let contri = account(&root, "contri").await?.deploy(&wasm("CONTRI_WASM")).await?.into_result()?;
    let token = format!("nep141:{}", usdt.id());
    let r = contri
        .call("new")
        .args_json(json!({"intents_id": intents.id(), "token_id": token}))
        .transact()
        .await?;
    check("contri init", &r)?;

    Ok(Env { worker, root, usdt, intents, contri, token })
}

impl Env {
    /// Deposits USDT into `who`'s NEAR Intents balance, as a top-up would.
    async fn fund(&self, who: &str, amount: u128) -> Result<()> {
        let r = self
            .usdt
            .call("ft_transfer_call")
            .args_json(json!({"receiver_id": self.intents.id(), "amount": amount.to_string(), "msg": who}))
            .deposit(NearToken::from_yoctonear(1))
            .max_gas()
            .transact()
            .await?;
        check(&format!("fund {who}"), &r)
    }

    async fn balance(&self, who: &str) -> Result<u128> {
        let v: String = self
            .intents
            .view("mt_balance_of")
            .args_json(json!({"account_id": who, "token_id": self.token}))
            .await?
            .json()?;
        Ok(v.parse()?)
    }

    /// A payment to Contri from `from`'s own Intents balance (`mt_transfer_call`).
    async fn pay(&self, from: &Account, amount: u128, msg: &str) -> Result<Vec<String>> {
        let r = from
            .call(self.intents.id(), "mt_transfer_call")
            .args_json(json!({
                "receiver_id": self.contri.id(),
                "token_id": self.token,
                "amount": amount.to_string(),
                "msg": msg
            }))
            .deposit(NearToken::from_yoctonear(1))
            .max_gas()
            .transact()
            .await?;
        check(&format!("{} pays {msg}", from.id()), &r)?;
        Ok(r.json()?)
    }

    async fn call(&self, from: &Account, method: &str, args: Value) -> Result<ExecutionFinalResult> {
        let r = from.call(self.contri.id(), method).args_json(args).max_gas().transact().await?;
        check(&format!("{} calls {method}", from.id()), &r)?;
        Ok(r)
    }

    async fn view(&self, method: &str, args: Value) -> Result<Value> {
        Ok(self.contri.view(method).args_json(args).await?.json()?)
    }

    async fn circle(&self, id: u64) -> Result<Value> {
        self.view("get_circle", json!({"circle_id": id})).await
    }

    /// Moves the sandbox clock past a circle's current round deadline.
    async fn pass_deadline(&self, id: u64) -> Result<()> {
        let deadline: u64 = self.circle(id).await?["round_deadline"].as_str().unwrap().parse()?;
        for _ in 0..20 {
            if self.worker.view_block().await?.timestamp() > deadline {
                return Ok(());
            }
            self.worker.fast_forward(100).await?;
        }
        bail!("the sandbox clock didn't reach the deadline")
    }

    /// Signs intents for NEAR Intents the way a member's app does: NEP-413
    /// with an ed25519 key whose account is the key's implicit account.
    fn sign(&self, key: &SigningKey, intents: Value, salt: u8) -> Value {
        let signer_id = hex::encode(key.verifying_key().as_bytes());
        let message = json!({"signer_id": signer_id, "deadline": "2099-01-01T00:00:00Z", "intents": intents}).to_string();
        let mut nonce: [u8; 32] = Sha256::digest(format!("{message}{salt}")).into();
        nonce[0] = 0; // never the versioned-nonce magic prefix
        let recipient = self.intents.id().to_string();
        let mut prehash = Vec::new();
        prehash.extend_from_slice(&((1u32 << 31) + 413).to_le_bytes());
        prehash.extend_from_slice(&(message.len() as u32).to_le_bytes());
        prehash.extend_from_slice(message.as_bytes());
        prehash.extend_from_slice(&nonce);
        prehash.extend_from_slice(&(recipient.len() as u32).to_le_bytes());
        prehash.extend_from_slice(recipient.as_bytes());
        prehash.push(0); // no callback url
        let hash = Sha256::digest(&prehash);
        let signature = key.sign(&hash);
        json!({
            "standard": "nep413",
            "payload": {
                "message": message,
                "nonce": base64::engine::general_purpose::STANDARD.encode(nonce),
                "recipient": recipient
            },
            "public_key": format!("ed25519:{}", bs58::encode(key.verifying_key().as_bytes()).into_string()),
            "signature": format!("ed25519:{}", bs58::encode(signature.to_bytes()).into_string())
        })
    }

    /// Submits signed intents as Contri's relayer does.
    async fn execute(&self, what: &str, signed: Value) -> Result<()> {
        let r = self
            .root
            .call(self.intents.id(), "execute_intents")
            .args_json(json!({"signed": [signed]}))
            .max_gas()
            .transact()
            .await?;
        check(what, &r)
    }
}

#[tokio::test]
async fn a_whole_circle_through_near_intents() -> Result<()> {
    let env = setup().await?;
    let ada = account(&env.root, "ada").await?;
    let bayo = account(&env.root, "bayo").await?;
    let chioma = account(&env.root, "chioma").await?;
    for m in [&ada, &bayo, &chioma] {
        env.fund(m.id().as_str(), 50 * USDT).await?;
    }
    let total = |a: u128, b: u128, c: u128| a + b + c;
    let start = total(
        env.balance(ada.id().as_str()).await?,
        env.balance(bayo.id().as_str()).await?,
        env.balance(chioma.id().as_str()).await?,
    );

    // Ada creates the circle with her deposit and takes the first seat.
    let used = env.pay(&ada, C, &format!("create:{C}:3:{PERIOD_SECS}:join:-:c2VhbGVk")).await?;
    ensure!(used == vec![C.to_string()], "create kept the deposit: {used:?}");
    // A wrong deposit is refunded by Intents.
    let used = env.pay(&bayo, C - 1, "join:0").await?;
    ensure!(used == vec!["0".to_string()], "wrong deposit refunded: {used:?}");
    env.pay(&bayo, C, "join:0").await?;
    env.pay(&chioma, C, "join:0").await?;
    let circle = env.circle(0).await?;
    ensure!(circle["status"] == "Active", "circle started: {circle}");
    ensure!(env.view("nft_total_supply", json!({})).await? == "3");

    // Chioma buys Ada's first turn for 1 USDT. Ada is paid through Intents.
    env.call(&ada, "list_seat", json!({"circle_id": 0, "seat": 0, "price": USDT.to_string()})).await?;
    let ada_before = env.balance(ada.id().as_str()).await?;
    env.pay(&chioma, USDT, "buy_seat:0:0").await?;
    ensure!(env.balance(ada.id().as_str()).await? == ada_before + USDT, "seller paid");
    let circle = env.circle(0).await?;
    ensure!(circle["members"][0]["account_id"] == chioma.id().as_str(), "seats swapped");

    // Round 0: the last contribution pays the pot out on its own.
    let chioma_before = env.balance(chioma.id().as_str()).await?;
    for m in [&ada, &bayo, &chioma] {
        env.pay(m, C, "contribute:0:0").await?;
    }
    let circle = env.circle(0).await?;
    ensure!(circle["round"] == 1, "round 0 paid out automatically: {circle}");
    ensure!(
        env.balance(chioma.id().as_str()).await? == chioma_before - C + 3 * C,
        "Chioma received the pot"
    );

    // Round 1: Chioma misses. After the deadline anyone settles, her deposit
    // covers it, and Bayo gets a full pot.
    let bayo_before = env.balance(bayo.id().as_str()).await?;
    env.pay(&ada, C, "contribute:0:1").await?;
    env.pay(&bayo, C, "contribute:0:1").await?;
    env.pass_deadline(0).await?;
    env.call(&env.root, "settle_round", json!({"circle_id": 0})).await?;
    let circle = env.circle(0).await?;
    ensure!(circle["round"] == 2, "round 1 settled: {circle}");
    ensure!(circle["members"][0]["defaulted"] == true);
    ensure!(env.balance(bayo.id().as_str()).await? == bayo_before - C + 3 * C, "Bayo got a full pot");

    // Round 2: everyone pays; Ada (now last) is paid and the circle finishes.
    for m in [&ada, &bayo, &chioma] {
        env.pay(m, C, "contribute:0:2").await?;
    }
    ensure!(env.circle(0).await?["status"] == "Finished");

    // Deposits come back, the circle is deleted, and no money is left behind.
    let r = env.call(&env.root, "release_deposits", json!({"circle_id": 0})).await?;
    ensure!(r.json::<u32>()? == 2, "Ada's and Bayo's deposits sent");
    env.call(&env.root, "close_circle", json!({"circle_id": 0})).await?;
    ensure!(env.circle(0).await?.is_null(), "circle deleted");
    ensure!(env.balance(env.contri.id().as_str()).await? == 0, "Contri holds nothing after the circle");
    let end = total(
        env.balance(ada.id().as_str()).await?,
        env.balance(bayo.id().as_str()).await?,
        env.balance(chioma.id().as_str()).await?,
    );
    ensure!(end == start, "no money created or lost: {start} -> {end}");
    ensure!(env.balance(ada.id().as_str()).await? == 50 * USDT + USDT, "Ada: +1 USDT for her seat");
    ensure!(env.balance(chioma.id().as_str()).await? == 50 * USDT - USDT, "Chioma: paid 1 USDT for it");
    let record = env.view("get_record", json!({"account_id": chioma.id()})).await?;
    ensure!(record["defaults"] == 1, "Chioma's record shows the default: {record}");
    Ok(())
}

#[tokio::test]
async fn members_with_only_a_key_use_signed_intents() -> Result<()> {
    let env = setup().await?;
    let ada = account(&env.root, "ada").await?;
    let bayo = account(&env.root, "bayo").await?;
    env.fund(ada.id().as_str(), 50 * USDT).await?;
    env.fund(bayo.id().as_str(), 50 * USDT).await?;

    // A member with no NEAR account: an ed25519 key (in the app, derived from
    // the passkey) and its implicit account.
    let key = SigningKey::from_bytes(&[42; 32]);
    let member: AccountId = hex::encode(key.verifying_key().as_bytes()).parse()?;
    env.fund(member.as_str(), 20 * USDT).await?;

    env.pay(&ada, C, &format!("create:{C}:3:{PERIOD_SECS}:join:-:c2VhbGVk")).await?;
    let transfer = |amount: u128, msg: &str, min_gas: Option<&str>| {
        let mut tokens = serde_json::Map::new();
        tokens.insert(env.token.clone(), json!(amount.to_string()));
        let mut intent = json!({
            "intent": "transfer",
            "receiver_id": env.contri.id(),
            "tokens": tokens,
            "msg": msg
        });
        if let Some(g) = min_gas {
            intent["min_gas"] = json!(g);
        }
        json!([intent])
    };

    // Join with a signed Transfer intent, then leave with a signed AuthCall:
    // the deposit comes back.
    env.execute("signed join", env.sign(&key, transfer(C, "join:0", None), 1)).await?;
    ensure!(env.circle(0).await?["members"][1]["account_id"] == member.as_str(), "joined by intent");
    ensure!(env.balance(member.as_str()).await? == 20 * USDT - C);
    let leave = json!([{"intent": "auth_call", "contract_id": env.contri.id(), "msg": "leave:0"}]);
    env.execute("signed leave", env.sign(&key, leave, 2)).await?;
    ensure!(env.circle(0).await?["members"].as_array().unwrap().len() == 1, "left");
    ensure!(env.balance(member.as_str()).await? == 20 * USDT, "deposit returned");

    // Join again, fill the circle, and pay the last contribution by intent:
    // it pays the pot out on its own.
    env.execute("signed join again", env.sign(&key, transfer(C, "join:0", None), 3)).await?;
    env.pay(&bayo, C, "join:0").await?;
    env.pay(&ada, C, "contribute:0:0").await?;
    env.pay(&bayo, C, "contribute:0:0").await?;
    let ada_before = env.balance(ada.id().as_str()).await?;
    let signed = env.sign(&key, transfer(C, "contribute:0:0", Some("100000000000000")), 4);
    env.execute("signed contribution (last one)", signed).await?;
    let circle = env.circle(0).await?;
    ensure!(circle["round"] == 1, "paid out after a signed contribution: {circle}");
    ensure!(env.balance(ada.id().as_str()).await? == ada_before + 3 * C, "Ada received the pot");
    Ok(())
}

/// The web app's own code runs a whole circle against these contracts: keys
/// derived as in the browser, intents signed by the app's library, and every
/// action sent through the app's relayer, read proxy and keeper handlers.
/// See app/test/e2e/sandbox.js.
#[tokio::test]
async fn the_app_runs_a_circle_through_its_relayer() -> Result<()> {
    let env = setup().await?;
    let script = concat!(env!("CARGO_MANIFEST_DIR"), "/../../app/test/e2e/sandbox.js");
    let out = std::process::Command::new("node")
        .arg(script)
        .env("NEAR_RPC", env.worker.rpc_addr())
        .env("NEAR_NETWORK", "sandbox")
        .env("CONTRI_ACCOUNT_ID", env.contri.id().as_str())
        .env("INTENTS_ID", env.intents.id().as_str())
        .env("TOKEN_ID", &env.token)
        .env("RELAYER_ACCOUNT_ID", env.root.id().as_str())
        .env("RELAYER_KEY", env.root.secret_key().to_string())
        .env("FUNDER_ID", env.usdt.id().as_str())
        .env("FUNDER_KEY", env.usdt.as_account().secret_key().to_string())
        .output()?;
    println!("{}", String::from_utf8_lossy(&out.stdout));
    eprintln!("{}", String::from_utf8_lossy(&out.stderr));
    ensure!(out.status.success(), "the app's end-to-end script failed");
    Ok(())
}

/// The real app in a real browser: two members with their own passkeys
/// (virtual authenticators with PRF) sign up, start a circle, invite, join,
/// pay and get paid by clicking through the app. See app/test/e2e/browser.js.
/// Screenshots go to $SHOTS.
#[tokio::test]
async fn the_app_works_in_a_browser() -> Result<()> {
    let env = setup().await?;
    let script = concat!(env!("CARGO_MANIFEST_DIR"), "/../../app/test/e2e/browser.js");
    let out = std::process::Command::new("node")
        .arg(script)
        .env("NEAR_RPC", env.worker.rpc_addr())
        .env("NEAR_NETWORK", "sandbox")
        .env("CONTRI_ACCOUNT_ID", env.contri.id().as_str())
        .env("INTENTS_ID", env.intents.id().as_str())
        .env("TOKEN_ID", &env.token)
        .env("RELAYER_ACCOUNT_ID", env.root.id().as_str())
        .env("RELAYER_KEY", env.root.secret_key().to_string())
        .env("FUNDER_ID", env.usdt.id().as_str())
        .env("FUNDER_KEY", env.usdt.as_account().secret_key().to_string())
        .output()?;
    println!("{}", String::from_utf8_lossy(&out.stdout));
    eprintln!("{}", String::from_utf8_lossy(&out.stderr));
    ensure!(out.status.success(), "the browser end-to-end script failed");
    Ok(())
}

/// The mainnet deploy script, against the sandbox: from one funded account
/// (the relayer), it creates `circles.<relayer>`, deploys and initializes
/// Contri there, upgrades it in place, then locks it by deleting its key.
#[tokio::test]
async fn the_deploy_script_creates_upgrades_and_locks_the_contract() -> Result<()> {
    let env = setup().await?;
    let script = concat!(env!("CARGO_MANIFEST_DIR"), "/../../app/scripts/deploy.js");
    let run = |arg: &str| {
        std::process::Command::new("node")
            .arg(script)
            .arg(arg)
            .env("NEAR_RPC", env.worker.rpc_addr())
            .env("NEAR_NETWORK", "sandbox")
            .env("INTENTS_ID", env.intents.id().as_str())
            .env("TOKEN_ID", &env.token)
            .env("RELAYER_ACCOUNT_ID", env.root.id().as_str())
            .env("RELAYER_KEY", env.root.secret_key().to_string())
            .output()
    };
    for (what, arg) in [("first deploy", std::env::var("CONTRI_WASM")?), ("upgrade", std::env::var("CONTRI_WASM")?), ("lock", "--lock".to_string())] {
        let out = run(&arg)?;
        println!("{what}:\n{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        ensure!(out.status.success(), "{what} failed");
    }
    let id: AccountId = format!("circles.{}", env.root.id()).parse()?;
    let config: Value = env.worker.view(&id, "get_config").await?.json()?;
    ensure!(config["intents_id"] == env.intents.id().as_str(), "initialized for NEAR Intents: {config}");
    let keys = env.worker.view_access_keys(&id).await?;
    ensure!(keys.is_empty(), "locked: no keys left");
    Ok(())
}
