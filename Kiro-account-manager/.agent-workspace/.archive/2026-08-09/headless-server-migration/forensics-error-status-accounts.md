# Forensics: has the `!item.success` → `status:'error'` defect already bitten this user?

- Date: 2026-08-10
- Mode: read-only forensics. No account data, store file, or source file was modified.
- Store located: `C:\Users\7\AppData\Roaming\kiro-account-manager\kiro-accounts.json`
  (`appId: com.kiro.account-manager`, but electron-store used the `package.json` name → dir is `kiro-account-manager`).
- Decryption: verified against `node_modules/conf/dist/source/index.js:281-286` —
  `iv = data[0..16]`, `pbkdf2Sync(key, iv, 10000, 32, 'sha512')`, `aes-256-cbc`, ciphertext at `data.slice(17)`.
  Primary (non-legacy) scheme decrypted all six files cleanly.

## 0. App running state

The app **is running right now** — 4 `electron.exe` processes, dev mode
(`F:\Kiro-account-manager\Kiro-account-manager\node_modules\electron\dist\electron.exe .`),
and the child processes carry `--user-data-dir="C:\Users\7\AppData\Roaming\kiro-account-manager"`.

So the file examined **is the live profile** of the currently running instance. The store was
not locked — `electron-store` writes atomically and does not hold an exclusive read lock, so
reading a byte-for-byte copy in-memory succeeded without any force or interference.
File mtime `2026-08-09T18:43:33Z`, `revision=902`.

## 1. Counts

| Store file | total | active | error | other |
|---|---|---|---|---|
| **LIVE `kiro-accounts.json`** | **1** | **1** | **0** | 0 |
| `SNAPSHOT-20260723-022448\kiro-accounts.json` | 65 | 27 | 38 | 0 |
| `.bak-2026-07-01T16-35-01` | 11 | 4 | 7 | 0 |
| `.bak-fix3-2026-07-01T16-45-05` | 11 | 4 | 7 | 0 |
| `.CORRUPTED-20260712-0507.bak` | 2 | 2 | 0 | 0 |
| `.EMERGENCY-20260712-0503.bak` | 2 | 2 | 0 | 0 |

Note on shape: `accountData.accounts` is a **keyed object, not an array**
(`accounts["<id>"] = {...}`). An `Array.isArray` guard silently yields zero accounts —
worth knowing for any future script or migration touching this store.

Live store also: `proxyEnabled=false`, `accountData.proxyPool = {}` (empty), `proxyPoolCursor=0`.

## 2. Per-`error`-account verdicts

### LIVE store — no `error` accounts at all

The single stored account is `status: 'active'`. Nothing to classify.

### SNAPSHOT-20260723 (38 error accounts) — 1 network-looking, 37 genuine

- 37 of 38 are unambiguous genuine account/credential failures, dominated by
  `HTTP 400 {"error":"invalid_request","error_description":"Invalid token provided"}`,
  plus `HTTP 401 invalid_client / Invalid client secret provided`, one Azure
  `AADSTS9002313`, and three `[TEMPORARILY_SUSPENDED] ... unusual user activity`.
- The 1 network-looking one:

  | field | value |
  |---|---|
  | id | `michaelwilson583@gmail.com-1783971256990` |
  | email | `mi***@gmail.com` |
  | status | `error` |
  | lastError | `fetch failed` |
  | expiresAt | 2026-07-14T09:08:10Z (**already 8 days expired** at snapshot time 2026-07-22) |
  | usage | 9375.21/10000 |
  | verdict | **network-looking, but NOT otherwise healthy** |

  Its `lastChecked` is `17:52:11`, ten seconds after the 17:52:01 batch that returned
  `Invalid token provided` for 30+ siblings. Expired token + same cohort + same sweep:
  this account would almost certainly have been marked `error` on its merits. The
  transport failure decided the *error text*, not the *outcome*.

### bak-fix3-2026-07-01 (7 error accounts) — 1 network-looking, 1 ambiguous, 5 genuine

- Network-looking:

  | field | value |
  |---|---|
  | id | `9a1bbbf1-8ed5-49a6-b733-b6a49792372c` |
  | email | `sa***@gmail.com` |
  | status | `error` |
  | lastError | `fetch failed` |
  | expiresAt | 2026-06-24T11:10:04Z (**expired 7 days before** this file's 2026-07-01 mtime) |
  | usage | 362.87/2000 |
  | verdict | **network-looking text, but the account was ALREADY `error` for a genuine reason** |

  This is the discriminating find. Comparing the two 2026-07-01 backups, nine minutes apart:

  - `bak-2026-07-01` (16:28) — same id, `status: error`,
    `lastError = HTTP 400 {"error":"invalid_grant","error_description":"Invalid refresh token provided"}`
  - `bak-fix3` (16:37) — same id, `status: error`, `lastError = "fetch failed"`

  So the network failure **overwrote the error text of an already-failed account**. It did
  not demote a healthy one. This is the defect's real observed footprint here: it corrupts
  diagnostic information, not (so far) availability.

- Ambiguous: `re***@kakao.com` (`6ca4dc72-...`), `HTTP 429 Too many requests`,
  token expired 2026-06-28, usage 10962.81/5000 (over limit). 429 is transient in
  principle, but with an expired token and usage past limit this account was not healthy.
  (Consistent with the separately-tracked hold-gate 429 quota false-positive topic.)

- The other 5: `Invalid token provided` / `Bad credentials` / `[TEMPORARILY_SUSPENDED]` — genuine.

### bak-2026-07-01, CORRUPTED-20260712, EMERGENCY-20260712

Zero network-looking. The two 2026-07-12 files have no `error` accounts at all.

## 3. Bottom line

**Zero. Not yet triggered — in the availability sense that matters.**

- Currently excluded from the reverse-proxy pool for a transient network reason while
  otherwise healthy: **0 accounts.** The live store holds 1 account, and it is `active`.
  `proxyEnabled=false` and `proxyPool` is empty, so there is no pool being starved today.
- Across all six historical files, exactly **2** accounts ever carried a
  network-shaped `lastError` (`fetch failed`, both of them). In **both** cases the account
  was independently already broken — expired token, and for `9a1bbbf1` a `status: error`
  with a genuine `invalid_grant` recorded nine minutes earlier. **No instance was found of
  a healthy, unexpired, in-quota account being flipped to `error` by a transport failure.**

So the defect is **real in code but so far only cosmetic in this user's data**: its
demonstrated effect has been to overwrite a genuine diagnostic message with `fetch failed`,
which makes triage harder (you cannot tell "the network hiccuped" from "this account is dead")
but has not yet cost a usable account.

Two reasons not to file this as harmless:

1. **The observed sample is unrepresentative of the risk window.** Every `fetch failed`
   found landed on an account that was already expired. That is luck of timing, not a
   protective mechanism — nothing in `persistCheckResult.ts:258-259` distinguishes the
   two cases, so a fleet-wide check during an offline moment would flip healthy accounts
   just as readily.
2. **Blast radius is currently masked by an empty pool.** The historical snapshot had 65
   accounts and `proxyEnabled: true`; the live profile has 1 and the proxy disabled. Given
   the headless-server-migration context, this user's real fleet plausibly lives on another
   machine or profile — this forensics pass can only speak for **this** profile. A store
   with 27 active accounts behind an enabled pool is precisely where a single offline sweep
   becomes 27 manual re-activation clicks.

## 4. Method notes / limits

- Only `%APPDATA%\kiro-account-manager` exists; an Everything filesystem-level search for
  `kiro-accounts.json` returned exactly the 6 files above (no `%LOCALAPPDATA%` variant, no
  second profile on this machine).
- `kiro-accounts.backup.enc` was **not** read: it is `safeStorage`/DPAPI-encrypted and only
  decryptable from inside the Electron main process. The plaintext `.backup.json` legacy
  path does not exist. This is a genuine gap, but the `.enc` mirrors the same `accountData`
  the primary store holds, so it is unlikely to contain accounts the primary lacks.
- Verdict classification was regex-based over `lastError` (network markers vs
  credential/suspension/HTTP-auth markers) and then manually reviewed for every non-genuine
  hit; the genuine bucket was spot-checked, not read line by line.
- Temp decrypt script was written to `%TEMP%`, run, and deleted. No decrypted content was
  written to disk. No token, secret, client id, or `ksk_` value appears in this report.
