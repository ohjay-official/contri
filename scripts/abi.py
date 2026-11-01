#!/usr/bin/env python3
"""ABI helpers for CI.

sync <generated.json> <committed.json> <drift-flag-file>
    Writes the ABI generated from contract/interface to the committed path,
    named "contri", and records whether its methods and types changed from the
    committed copy ("true"/"false"). Build details (compiler and cargo-near
    versions) are not compared.

exports <contract.wasm> <abi.json>
    Fails unless the ABI lists exactly the functions the contract exports,
    apart from __contract_abi itself.
"""
import json
import os
import sys


def sync(generated_path, committed_path, flag_path):
    abi = json.load(open(generated_path))
    abi["metadata"]["name"] = "contri"
    old = json.load(open(committed_path)) if os.path.exists(committed_path) else None
    same = (
        old is not None
        and old.get("body") == abi.get("body")
        and old["metadata"].get("version") == abi["metadata"].get("version")
    )
    with open(committed_path, "w") as f:
        json.dump(abi, f, indent=2)
        f.write("\n")
    with open(flag_path, "w") as f:
        f.write("false" if same else "true")
    names = [fn["name"] for fn in abi["body"]["functions"]]
    print(f"ABI: {len(names)} functions; {'in sync with' if same else 'DIFFERENT from'} the committed copy")


def leb128(b, i):
    value = shift = 0
    while True:
        byte = b[i]
        i += 1
        value |= (byte & 0x7F) << shift
        shift += 7
        if byte < 0x80:
            return value, i


def exported_functions(wasm_path):
    b = open(wasm_path, "rb").read()
    if b[:4] != b"\0asm":
        sys.exit(f"{wasm_path} is not a wasm file")
    i, names = 8, set()
    while i < len(b):
        section = b[i]
        size, i = leb128(b, i + 1)
        end = i + size
        if section == 7:  # export section
            count, i = leb128(b, i)
            for _ in range(count):
                length, i = leb128(b, i)
                name = b[i : i + length].decode()
                i += length
                kind = b[i]
                _, i = leb128(b, i + 1)
                if kind == 0:  # function
                    names.add(name)
        i = end
    return names


def exports(wasm_path, abi_path):
    exported = exported_functions(wasm_path) - {"__contract_abi"}
    described = {fn["name"] for fn in json.load(open(abi_path))["body"]["functions"]}
    missing_from_abi = sorted(exported - described)
    not_exported = sorted(described - exported)
    print(f"contract exports {len(exported)} methods, ABI describes {len(described)}")
    if missing_from_abi:
        print("exported but not in the ABI:", ", ".join(missing_from_abi))
    if not_exported:
        print("in the ABI but not exported:", ", ".join(not_exported))
    if missing_from_abi or not_exported:
        sys.exit(1)
    print("ABI and exports match")


if __name__ == "__main__":
    command, *rest = sys.argv[1:]
    {"sync": sync, "exports": exports}[command](*rest)
