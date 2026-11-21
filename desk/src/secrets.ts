// Loads the Desk payer key in-process from a KEY=VALUE / KEY: VALUE file
// (the operator's .secrets/env.txt). The value is returned to the caller
// only; it is never logged, printed, or written anywhere.
import { readFileSync } from "node:fs";

export function readSecret(file: string, key: string): string {
  const text = readFileSync(file, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_\- ]+?)\s*[=:]\s*(.*)$/.exec(raw);
    if (m && m[1] === key) {
      const v = m[2].trim().replace(/^["']|["']$/g, "");
      if (v) return v;
    }
  }
  throw new Error(`secret ${key} not found in the secrets file`);
}

export function normalizePrivateKey(v: string): `0x${string}` {
  const hex = v.startsWith("0x") ? v.slice(2) : v;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("private key is not 32 bytes of hex");
  return `0x${hex}` as `0x${string}`;
}
