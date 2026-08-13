# Ban / suspension semantics reconnaissance (#26, #27, #30)

- Date: 2026-08-13
- Mode: Reality Recon, read-only except this requested report
- Scope: suspension representation, headless recovery, classifier duplication only
- Code baseline inspected: `edcb42c`

## Executive verdict

1. **#26 confirmed.** The runtime model has one latching triplet,
   `suspendedAt/suspendReason/suspendMessage`, and availability reads only whether
   `suspendedAt > 0` (`src/main/proxy/types.ts:460-465`,
   `src/main/proxy/accountPool.ts:333-337,382-385`). The detector emits materially
   different labels — including `TEMPORARILY_SUSPENDED`,
   `ACCOUNT_SUSPENDED`, `PERMANENTLY_SUSPENDED`,
   `AccountSuspendedException`, and `ACCOUNT_LOCKED` — into that same latch
   (`src/main/proxy/proxyServer.ts:1480-1514`). None self-recovers in this
   application: a latched account stays unavailable until `clearSuspended`
   (`src/main/proxy/accountPool.ts:388-421`), and even a later success is explicitly
   forbidden from clearing it (`src/main/proxy/accountPool.ts:510-524`).

2. **The upstream recovery timescale is not established.** Archived data contains
   three real `[TEMPORARILY_SUSPENDED] ... unusual user activity` records
   (`.agent-workspace/.archive/2026-08-09/headless-server-migration/forensics-error-status-accounts.md:45-50`),
   but no observation pairing a suspension timestamp with a later successful
   recovery. The earlier recon called the state self-recovering from its name, but
   that same report admits there is no duration data
   (`.agent-workspace/.archive/2026-08-09/headless-server-migration/recon-suspension-recovery.md:131-135`).
   Therefore: `TEMPORARILY_SUSPENDED` verifiably expresses an intended temporary
   class; **unverified: whether it actually self-recovers, and after how long**.

3. **#27 confirmed.** `clearSuspended` is reachable from desktop IPC and two desktop
   controls (`src/main/index.ts:5228-5258`,
   `src/renderer/src/components/accounts/AccountCard.tsx:180-199,933-946`,
   `src/renderer/src/components/accounts/AccountListRow.tsx:259-271`), but the panel
   dependency contract and account route switch expose no equivalent
   (`src/main/webPanel/routes.ts:61-125,925-992`). The browser API likewise has
   edit/delete/restore/check calls but no suspension-recovery call
   (`src/webPanel/api/panel.ts:100-128,191-202`). This is a hard headless-operability
   gap.

4. **The existing desktop operation is semantically unsafe, not merely absent on
   mobile.** It clears the pool latch, writes `status:'active'`, and erases
   `lastError` without probing the upstream (`src/main/index.ts:5231-5254`).
   “Unsuspend” should become **verify recovery and then clear local restriction**,
   not “let the user assert that upstream recovered.”

5. **#30 confirmed, with a stale reported list.** There are **nine general-purpose
   raw-text classifiers**, not five. `AccountSelectDialog` still has its own copy;
   `main/index.ts`, `accountService/autoSwitch.ts`, and renderer
   `store/accounts.ts` add three more. There are also seven narrower raw-signal
   decision sites. The keyword sets have observable behavioral divergence:
   `ACCOUNT_SUSPENDED` can be latched at runtime but is missed by restart admission;
   `PERMANENTLY_SUSPENDED`, `ACCOUNT_LOCKED`, and `用户状态异常` are admission-only;
   most copies treat any standalone `423` as a ban although the authoritative
   detector requires `423` plus `locked|suspended`.

6. **Primary fix: structured state emitted by the backend.** A shared raw-string
   classifier is still useful **at upstream protocol boundaries and for one-time
   legacy migration**, but it must not become a browser-importable keyword helper.
   Main, renderer, panel, schedulers, and pool admission should consume one
   persisted structured restriction object. The current comments themselves expose
   the bad boundary: admission says it unions UI keyword copies
   (`src/main/proxy/activation.ts:55-61`), and panel formatting says it reparses
   because the DTO supplies only `lastError`
   (`src/webPanel/ui/format.ts:60-64`).

## Method and confidence

- Used `mcphub` semantic search through
  `codebase-context-engine-search_context` and `fast-context-fast_context_search`
  to discover producers, consumers, panel seams, and archive evidence.
- Attempted `codegraph-codegraph_explore` repeatedly; it returned `Not connected`.
  `unverified: codegraph index results were unavailable in this session`.
- The exact census was then checked with filesystem ripgrep using hidden/no-ignore
  traversal, excluding `.git`, dependencies, and generated output. An Everything
  filesystem query and the two working semantic searches were used as independent
  checks, so the census was not inferred from `git grep`.
- This was static reconnaissance. `unverified: no live Kiro account was suspended
  or allowed to recover during this task`.
- Command evidence at final verification: the tracked diff already contains
  `.agent-workspace/TASKS-2026-08-13.md` and `package-lock.json`, and the git root
  contains numerous unrelated untracked workspaces/reports. This requested report is
  also untracked. The dispatch baseline may have been clean, but implementers must
  re-check ownership before editing; no source file was changed by this recon.

## #26 — what the current representation actually does

### Producer-to-consumer chain

1. `detectSuspendedError` parses raw error text and returns only
   `{reason:string,message:string}` (`src/main/proxy/proxyServer.ts:1480-1514`).
2. Four request paths feed that result to the same `markSuspended` operation
   (`src/main/proxy/proxyServer.ts:2052-2063,3642-3648,3914-3919,4993-5001`).
3. `markSuspended` sets the same fields and `isAvailable:false` for every reason
   (`src/main/proxy/accountPool.ts:388-404`); `isAccountAvailable` asks only whether
   the timestamp exists (`src/main/proxy/accountPool.ts:333-337,382-385`).
4. Desktop notification preserves `reason` in transit, but the renderer immediately
   flattens it into `status:'error' + lastError`
   (`src/main/index.ts:613-637`,
   `src/renderer/src/App.tsx:399-409`).
5. Headless persistence also flattens it to
   `status/lastError/lastCheckedAt`; it does **not** persist the runtime triplet
   (`src/main/server/persistence.ts:120-134,228-253`).
6. On restart, admission reconstructs a ban by parsing `lastError`; its own comment
   explicitly says it does not hydrate the runtime suspension fields
   (`src/main/proxy/activation.ts:118-123,138-143`).
7. The phone DTO exports `status` and `lastError`, but no structured restriction
   (`src/main/webPanel/dto.ts:62-99`), forcing the panel to classify again.

So the system currently has two lossy representations:

- in-process: one undifferentiated timestamp latch;
- persisted/cross-process: one free-text `lastError` string.

Neither can express temporary-versus-permanent recovery policy.

### Signals actually recognized

| Upstream signal seen by current code | What the signal itself establishes | Current app behavior | Upstream recovery / human-action finding |
|---|---|---|---|
| JSON `reason:"TEMPORARILY_SUSPENDED"` | Explicitly temporary-labelled suspension (`src/main/proxy/proxyServer.ts:1483-1494`) | Permanent local latch until manual clear (`src/main/proxy/accountPool.ts:382-421`) | Three archived observations exist (`forensics-error-status-accounts.md:45-50`); **unverified: self-recovery and timescale** |
| JSON `reason:"ACCOUNT_SUSPENDED"` | Suspension with no duration qualifier (`src/main/proxy/proxyServer.ts:1489-1494`) | Same latch; after restart the admission parser does not recognize the underscore token (`src/main/proxy/activation.ts:66-77`) | **unverified: whether support action is required** |
| JSON `reason:"PERMANENTLY_SUSPENDED"` | Explicitly permanent-labelled suspension (`src/main/proxy/proxyServer.ts:1489-1494`) | Same latch; admission recognizes it, most other copies do not (`src/main/proxy/activation.ts:66-77`) | Treat as human/upstream remediation, never TTL-clear. **unverified: exact remediation process; repo has no successful recovery observation** |
| `User ID is temporarily suspended` | Explicit temporary text (`src/main/proxy/proxyServer.ts:1497-1500`) | Same latch, normalized to `TEMPORARILY_SUSPENDED` | **unverified: self-recovery and timescale** |
| `User ID is suspended` (without `temporarily`) | Duration-unknown suspension | **Incorrectly normalized to `TEMPORARILY_SUSPENDED`** by the optional regex group (`src/main/proxy/proxyServer.ts:1497-1500`) | Must remain `unknown`, not inherit temporary policy |
| `AccountSuspendedException` / `Account suspended` | Generic exception/name; no temporal qualifier (`src/main/proxy/proxyServer.ts:1503-1506`) | Same latch, reason `AccountSuspendedException` | Code comments/UI assume support (`src/main/proxy/types.ts:460-465`, `src/renderer/src/components/accounts/AccountCard.tsx:922-930`), but **unverified: no archived recovery evidence proves mandatory support** |
| HTTP `423` plus `locked|suspended` | Locked/suspended response (`src/main/proxy/proxyServer.ts:1509-1511`) | Same latch, reason `ACCOUNT_LOCKED` | **unverified: lock duration and unlock mechanism** |
| API-key probe: HTTP 423 | Structured `SUSPENDED` credential state (`src/main/proxy/kiroApi.ts:661-672`) | Import/verification can return a typed result, but duration is discarded | **unverified: duration** |
| API-key body `__type=TEMPORARILY_SUSPENDED|AccountSuspended` or `subscriptionInfo.status=SUSPENDED` | Structural suspension fields (`src/main/proxy/kiroApi.ts:674-719`) | One coarse `CredentialState='SUSPENDED'` | Temporary/generic distinction is lost; **unverified: recovery behavior** |
| GetUserInfo status not `Active`/`Stale` (comment names Suspended/Disabled) | Structured non-active user status (`src/main/accountService/check.ts:594-611`) | Flattened to `用户状态异常: <status>`; admission treats all such text as backend rejection (`src/main/proxy/activation.ts:73-77`) | Suspended and Disabled are distinct upstream states but are collapsed; **unverified: actual observed values and recovery policies** |
| Registration usage HTTP 403 whose body contains `suspended` | Registration-scoped suspension (`src/main/registration/registrar.ts:1500-1509`) | Returns `{suspended:true}` in that flow | **unverified: whether this is the same account-state domain as proxy suspension** |

### What self-recovers today

- **Inside this application: none of the suspension signals.** The account is never
  selected while latched (`src/main/proxy/accountPool.ts:333-337`), so normal traffic
  cannot discover recovery. There is no TTL branch in `isSuspended`
  (`src/main/proxy/accountPool.ts:382-385`), and `recordSuccess` intentionally retains
  the latch (`src/main/proxy/accountPool.ts:510-524`).
- `TEMPORARILY_SUSPENDED` is the only signal that establishes a temporary *class*,
  but the archive establishes no duration. A hardcoded 30-minute (or any fixed) TTL
  would be invented policy; the prior recon explicitly said its TTL lacked evidence
  (`.agent-workspace/.archive/2026-08-09/headless-server-migration/recon-suspension-recovery.md:123-125,131-135`).
- `PERMANENTLY_SUSPENDED` is the only signal that establishes permanence from the
  signal itself. The other generic suspended/locked/disabled forms need an
  `unknown` duration class until upstream evidence is recorded.

### Archived observations, without overclaiming

- The historical snapshot had 38 error accounts, including three genuine
  `[TEMPORARILY_SUSPENDED] ... unusual user activity` records
  (`forensics-error-status-accounts.md:45-50`).
- The same forensics pass found two `fetch failed` records, but both accounts were
  independently already unhealthy; it found no healthy account made unavailable by
  transport error (`forensics-error-status-accounts.md:103-119`). This means the
  text/status design is demonstrably capable of corrupting diagnosis, but a healthy
  false suspension was not observed in that profile.
- That sample cannot establish fleet-wide safety; the report itself limits the
  conclusion to one local profile (`forensics-error-status-accounts.md:121-133`).

## #27 — headless recovery and the meaning of “unsuspend”

### Reachability finding

The desktop path is:

`AccountCard/AccountListRow` → preload IPC → `proxy-clear-account-suspended` →
`AccountPool.clearSuspended` + store mutation
(`src/renderer/src/components/accounts/AccountCard.tsx:180-199`,
`src/renderer/src/components/accounts/AccountListRow.tsx:259-271`,
`src/main/index.ts:5228-5258`).

The panel route contract includes check, refresh, switch, and proxy orchestration,
but no recovery dependency (`src/main/webPanel/routes.ts:61-125`); the route switch
contains `check`, `refresh-token`, `switch`, and `switch-cli`, but no unsuspend action
(`src/main/webPanel/routes.ts:925-961`). The panel card only derives a banned visual
state from `lastError` (`src/webPanel/ui/AccountCard.tsx:247-262`).

Therefore a headless operator can see a red account but cannot invoke the one local
recovery primitive.

### Required semantics by duration class

| Structured duration | Phone action | What must happen | What must not happen |
|---|---|---|---|
| `temporary` | “Retry now” | Run a real authenticated liveness probe outside normal pool selection. Clear the restriction only after a success observed after `lastObservedAt`; if the same restriction remains, update observation metadata. | Do not blindly clear on a guessed TTL; no measured TTL exists. Do not claim active on timeout/network error. |
| `permanent` | “Verify after remediation” + support guidance | Let the operator re-probe after upstream/support action. A real later success is sufficient evidence to clear the local record. | Do not auto-expire. Do not offer a one-click local assertion that the upstream state changed. |
| `unknown` | “Recheck status” | Probe and either refine the code/duration from a structured response, clear on success, or leave unchanged on indeterminate transport failure. | Do not silently coerce generic `suspended`, `locked`, or `Disabled` to temporary/permanent. |

The existing `clearSuspended` should remain an internal pool mutation, called only
after verified recovery (or an explicitly approved advanced override). The public
operation should be named around **retry/recheck**, because “clear” describes only a
local write.

## #30 — complete classifier census

### General-purpose copies (nine)

| ID | Definition | Consumers / purpose | Judgment |
|---|---|---|---|
| C1 | `detectSuspendedError`, `src/main/proxy/proxyServer.ts:1480-1514` | Four proxy request boundaries (`:2052-2063,3642-3648,3914-3919,4993-5001`) | **Legitimate authoritative protocol-boundary decision**, but generic `User ID is suspended` is mislabelled temporary |
| C2 | `isBackendRejectedError`, `src/main/proxy/activation.ts:63-78` | Restart/server pool admission (`:138-143`) | **Duplicated decision logic — defect** |
| C3 | `isAutoSwitchBannedError`, `src/main/accountService/autoSwitch.ts:97-115` | Candidate exclusion (`:186-190`) | **Duplicated decision logic — defect** |
| C4 | `isBannedAccountErrorMain`, `src/main/index.ts:1607-1616` | Main-process refresh scheduler exclusion (`:1695-1701`) | **Duplicated decision logic — defect** |
| C5 | `isBannedAccountError`, `src/renderer/src/store/accounts.ts:658-679` | Filtering/stats/notifications **and** auto-refresh exclusion (`:1611-1615,1923-1928,2526-2531,3244-3249`) | **Duplicated decision logic — defect**; not merely presentation |
| C6 | inline `isUnauthorized`, `src/renderer/src/components/accounts/AccountCard.tsx:376-386` | Card styling, dialog, reset control | **Duplicated decision logic — defect**; visual location does not make raw-text classification presentation |
| C7 | `isBannedError`, `src/renderer/src/components/accounts/_helpers.ts:165-179` | Account list row (`src/renderer/src/components/accounts/AccountListRow.tsx:83-87`) | **Duplicated decision logic — defect** |
| C8 | inline `isBannedAccount`, `src/renderer/src/components/proxy/AccountSelectDialog.tsx:75-100` | Excludes/labels choices in proxy account selector | **Duplicated decision logic — defect**; this stale-list entry still exists |
| C9 | `isBannedError`, `src/webPanel/ui/format.ts:60-78` | Phone card via `src/webPanel/ui/AccountCard.tsx:247-262` | **Duplicated decision logic — defect** |

Legend for the matrix: `✓` = explicit positive rule; `△` = conditional/narrower
match; `~` = matched only because the copy also has a broader substring; `—` =
missing. C1’s `JSON` entries require a `"reason":"..."` field, not just a free token.

| Positive signal / keyword | C1 | C2 | C3 | C4 | C5 | C6 | C7 | C8 | C9 |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `AccountSuspendedException` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `Account suspended` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `TEMPORARILY_SUSPENDED` | JSON | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `temporarily suspended` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `ACCOUNT_SUSPENDED` | JSON | — | — | — | — | — | — | — | — |
| `PERMANENTLY_SUSPENDED` | JSON | ✓ | — | — | — | — | — | — | — |
| literal `ACCOUNT_LOCKED` | — (output only) | ✓ | — | — | — | — | — | — | — |
| `User ID is … suspended` | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ | ✓ | ✓ |
| `账户已封禁` | — | ~ | ✓ | ~ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `已封禁` | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `用户状态异常` | — | ✓ | — | — | — | — | — | — | — |
| standalone numeric `423` | △ (`locked|suspended` also required) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

Exact source anchors for the matrix are the nine definitions in the census:
C1 `proxyServer.ts:1489-1511`; C2 `activation.ts:66-77`; C3
`autoSwitch.ts:106-114`; C4 `index.ts:1611-1616`; C5
`store/accounts.ts:661-669`; C6 `AccountCard.tsx:378-386`; C7
`_helpers.ts:170-178`; C8 `AccountSelectDialog.tsx:79-87`; C9
`webPanel/ui/format.ts:69-77`.

C5 and C8 also contain the same explicit negative-only list:
`fetch failed`, `network`, `token expired`, `token 过期`, `刷新失败`, and
`unauthorizedexception` (`src/renderer/src/store/accounts.ts:671-678`,
`src/renderer/src/components/proxy/AccountSelectDialog.tsx:89-98`). Because both
functions already return `false` for every unmatched string, these branches currently
do not change the boolean result; they are duplicated documentation encoded as dead
decision branches.

### Concrete divergence effects

1. C1 persists `[ACCOUNT_SUSPENDED] ...`, but C2 has neither
   `account_suspended` nor a generic standalone `suspended` rule. The runtime account
   is latched, yet after restart it can pass admission and return to the pool
   (`src/main/proxy/proxyServer.ts:1489-1494`,
   `src/main/proxy/activation.ts:66-77,138-143`).
2. C2 alone recognizes `PERMANENTLY_SUSPENDED`, `ACCOUNT_LOCKED`, and
   `用户状态异常`. Such records can be excluded from the pool while C3-C9 fail to
   present/skip them consistently (`src/main/proxy/activation.ts:66-77` versus the
   eight definitions above).
3. C1 requires `423` to be accompanied by `locked|suspended`; C2-C9 accept any
   numeric 423 token. A non-suspension message containing 423 can therefore be
   classified as banned everywhere except the protocol detector
   (`src/main/proxy/proxyServer.ts:1509-1511` versus C2-C9 anchors above).
4. C1 maps both `User ID is temporarily suspended` and unqualified
   `User ID is suspended` to `TEMPORARILY_SUSPENDED`, erasing duration uncertainty
   before downstream code sees it (`src/main/proxy/proxyServer.ts:1497-1500`).

### Narrow/scoped raw-signal decision sites

These are not all general-copy/paste functions, but they must be included in the
census because they still decide suspension from raw text or protocol fields.

| ID | Site and exact rule | Judgment / migration |
|---|---|---|
| S1 | Background token refresh catches `AccountSuspendedException` or any `423` (`src/main/accountService/backgroundRefresh.ts:350-367`) | **Duplicated backend decision**; call the authoritative normalizer |
| S2 | Account check catches `AccountSuspendedException`/`AccountSuspended` or any `423`, and separately rejects any user status except Active/Stale (`src/main/accountService/check.ts:577-618`) | Raw-error part is **duplicated**; structured user-status boundary is legitimate but must emit structured restriction |
| S3 | API-key probe uses HTTP 423, `body.__type`, and `subscriptionInfo.status` to emit typed `CredentialState='SUSPENDED'` (`src/main/proxy/kiroApi.ts:661-719`) | **Legitimate protocol-boundary decision**; enrich the typed result with code/duration rather than reparse later |
| S4 | Registrar uses HTTP 403 plus body substring `suspended` (`src/main/registration/registrar.ts:1500-1509`) | Legitimate registration boundary, but partial; delegate normalization and preserve source |
| S5 | Add-account probe regexes `TEMPORARILY_SUSPENDED|AccountSuspended|423 Locked|suspended` (`src/renderer/src/components/accounts/AddAccountDialog.tsx:1403-1415`) | **Duplicated renderer decision — defect**; liveness IPC should return typed outcome |
| S6 | Subscription eligibility uses `status==='error'` plus `suspended|封禁|temporarily` (`src/renderer/src/components/pages/SubscriptionPage.tsx:51-57`) | **Duplicated business decision — defect**; consume structured restriction |
| S7 | Registration page maps any error containing `suspended` to a UX category (`src/renderer/src/components/pages/RegisterPage.tsx:116-123`) | **Duplicated renderer decision — defect**; registration backend should return typed category |

Two nearby sites are **legitimate presentation, not classifier copies**:

- `accountService/verify.ts` maps the already-typed `CredentialProbeResult.state`
  to output (`src/main/accountService/verify.ts:118-157`).
- Browser API-key import UI branches on the typed `ApiKeyImportCode='SUSPENDED'`
  contract (`src/webPanel/api/panel.ts:162-185`).

Those are the model to follow: presentation consumes a decision; it does not inspect
an English/Chinese error string.

## Dependency-ordered implementation plan

### Step 1 — introduce and persist the structured restriction model

**Contract**

Add a shared, versioned object along these lines:

```ts
interface AccountRestriction {
  code:
    | 'TEMPORARILY_SUSPENDED'
    | 'ACCOUNT_SUSPENDED'
    | 'PERMANENTLY_SUSPENDED'
    | 'ACCOUNT_LOCKED'
    | 'ACCOUNT_DISABLED'
    | 'UNKNOWN_SUSPENSION'
  duration: 'temporary' | 'permanent' | 'unknown'
  source: 'proxy' | 'credential_probe' | 'user_info' | 'registration' | 'legacy'
  firstObservedAt: number
  lastObservedAt: number
  httpStatus?: number
  message?: string
}
```

Do not encode an invented TTL. Preserve unknown duration. Fix the generic
`User ID is suspended` branch so only the explicitly temporary spelling maps to
`duration:'temporary'`; only `PERMANENTLY_SUSPENDED` maps to
`duration:'permanent'`. Keep `lastError` as diagnostics, never as an availability
input.

**Files touched**

- New shared contract/normalizer, preferably
  `src/shared/types/accountRestriction.ts` and
  `src/shared/accountRestriction.ts`.
- Runtime producer and pool:
  `src/main/proxy/types.ts`, `src/main/proxy/proxyServer.ts`,
  `src/main/proxy/accountPool.ts`.
- Other upstream boundaries:
  `src/main/proxy/kiroApi.ts`,
  `src/main/accountService/check.ts`,
  `src/main/accountService/backgroundRefresh.ts`,
  `src/main/registration/registrar.ts`,
  `src/shared/types/credential.ts`.
- Persistence/hydration:
  `src/main/proxy/activation.ts`,
  `src/main/server/assembly.ts`,
  `src/main/server/persistence.ts`,
  `src/main/index.ts`.
- Desktop contract/store:
  `src/preload/index.ts`, `src/preload/index.d.ts`,
  `src/renderer/src/types/account.ts`,
  `src/renderer/src/App.tsx`,
  `src/renderer/src/store/accounts.ts`.
- Phone projection:
  `src/main/webPanel/dto.ts`, `src/webPanel/api/panel.ts`.
- Tests: add a table-driven normalizer/model suite; update
  `test/main/proxy/poolAdmission.test.ts`,
  `test/main/proxy/poolResyncPreservesRuntime.test.ts`, and
  `test/main/server/serverSeamsWiring.test.ts`.

**Migration rules**

- Dual-read legacy records for one compatibility window: exact known
  `[REASON] message` prefixes can be migrated to structured codes; ambiguous text
  becomes `UNKNOWN_SUSPENSION`, never guessed permanent/temporary.
- New writes always store `restriction`; restart admission and pool hydration read
  it directly. Do not exclude on `status` or `lastError`.
- Preserve restriction through `upsertAccount`/`replaceAll`; those methods already
  deliberately preserve the old runtime fields
  (`src/main/proxy/accountPool.ts:212-232,794-800,877-895`).
- A successful authenticated probe may clear a restriction only when that probe
  started after `lastObservedAt`; this prevents a late success from an older
  concurrent request erasing a newer suspension.

**Conflict notes**

- This is the contract root and must merge before Steps 2/3.
- `src/main/index.ts`, `activation.ts`, `accountPool.ts`, renderer
  `store/accounts.ts`, and web-panel DTO are high-conflict files. Freeze the shared
  type first; then backend persistence and renderer/panel projection can proceed in
  parallel against that exact type.
- Re-check the unrelated worktree modifications noted under Method. Do not overwrite
  current changes in `package-lock.json` or task ledgers.

**Proof of work**

- Table tests cover every signal row above, especially:
  generic `User ID is suspended → unknown`,
  explicit temporary/permanent, and `423` without `locked|suspended → not a
  restriction` at the proxy boundary.
- Round-trip tests prove desktop persistence, headless persistence, startup
  hydration, preload event, and panel DTO retain identical `code/duration/timestamps`.
- Restart test proves `[ACCOUNT_SUSPENDED]` no longer changes behavior across
  process restart.
- Network/timeout and plain `status:'error'` tests prove they do not create or clear
  restriction.
- Existing pool resync tests continue proving a UI/panel sync cannot silently erase
  a runtime restriction.

### Step 2 — expose verified recovery to desktop and phone

**Behavior**

Create one main-process account use case, e.g. `retryAccountRestriction(accountId)`.
It loads credentials server-side, performs a typed authenticated liveness probe
without selecting the blocked account from the normal pool, and returns one of:

- `RECOVERED` — probe succeeded; atomically clear persisted restriction and pool
  latch;
- `STILL_RESTRICTED` — update structured observation, leave blocked;
- `INDETERMINATE` — network/timeout/5xx; leave state unchanged;
- `NOT_RESTRICTED` — idempotent no-op.

Extract/reuse the existing direct inference probe currently embedded in desktop IPC;
that implementation already builds a `ProxyAccount` and calls `callKiroApi` directly
(`src/main/index.ts:2762-2868`). Desktop IPC and HTTP must delegate to the new use
case, not duplicate it.

Add an authenticated route such as
`POST /api/accounts/:id/retry-restriction`, with existing route CSRF/auth,
single-flight, and revision conventions. Add the phone card action:

- temporary: “Retry now”;
- permanent: “Verify after remediation” plus support link;
- unknown: “Recheck status.”

**Files touched**

- New shared use case:
  `src/main/accountService/restrictionRecovery.ts` (and a liveness helper if
  extraction warrants it), plus `src/main/accountService/types.ts` if the runtime
  dependency port needs the new probe/pool capability.
- Desktop delegate:
  `src/main/index.ts`; preload signatures only if the response contract changes;
  `src/renderer/src/components/accounts/AccountCard.tsx` and
  `src/renderer/src/components/accounts/AccountListRow.tsx` must call/render the
  verified-recovery contract instead of blind clear.
- Headless assembly:
  `src/main/server/assembly.ts` — it constructs `PanelRouteDeps` independently of
  Electron (`src/main/server/assembly.ts:14-24,1031-1057`), so changing only
  `webPanelWiring.ts` would leave the actual Linux/server path unwired.
- Panel dependency/route wiring:
  `src/main/webPanel/routes.ts`,
  `src/main/ipc/webPanelWiring.ts`.
- Browser client/UI:
  `src/webPanel/api/panel.ts`,
  `src/webPanel/ui/AccountCard.tsx`.
- Tests: a focused account-service suite, panel route auth/revision/single-flight
  tests, and phone-card interaction tests.

**Conflict notes**

- Depends on the Step 1 contract and persisted state; do not implement a temporary
  route that mutates `lastError`.
- This step conflicts with any concurrent account-management work in
  `routes.ts`, `webPanelWiring.ts`, `panel.ts`, and phone `AccountCard.tsx`.
- Keep `AccountPool.clearSuspended` as an internal primitive; only the recovery use
  case (or a separately approved override) should call it.

**Proof of work**

- Headless integration: start with a persisted restricted account, invoke the route
  with the desktop renderer absent, simulate a successful upstream probe, and prove
  both disk and live pool become available.
- Failure matrix: same suspension → remains blocked; network timeout → remains
  blocked and does not become active; stale/late success → cannot clear newer
  restriction.
- Route requires panel auth/CSRF, does not accept or return tokens, honors
  single-flight, and handles revision conflict.
- Desktop button and phone button produce the same result contract.
- `npm run typecheck`, focused Vitest suites, and `npm run build:webpanel` pass
  (scripts are defined at `package.json:12-28`).

### Step 3 — remove duplicated raw-text decisions

**Backend/business consumers**

- Delete C2/C3/C4 raw classifiers. Admission, auto-switch, and main refresh
  scheduling read `account.restriction`.
- Convert S1/S2/S4 to the shared upstream normalizer/typed producer contract.
- Keep C1/S3 as protocol-boundary adapters, preferably delegating to the same pure
  normalizer rather than maintaining separate keyword sets.

**Desktop/panel presentation**

- Delete C5-C9 and S5-S7 raw classification.
- Filtering, counts, notifications, account selector eligibility, subscription
  eligibility, card/list visuals, and phone visuals read the structured field.
- Presentation helpers may map `code/duration` to icon, label, support text, and
  button text. They must not inspect `lastError`.
- Make liveness/registration responses typed so AddAccountDialog/RegisterPage do not
  need regex fallbacks.

**Files touched**

- Backend:
  `src/main/proxy/activation.ts`,
  `src/main/accountService/autoSwitch.ts`,
  `src/main/accountService/backgroundRefresh.ts`,
  `src/main/accountService/check.ts`,
  `src/main/index.ts`,
  `src/main/registration/registrar.ts`.
- Desktop:
  `src/renderer/src/store/accounts.ts`,
  `src/renderer/src/App.tsx`,
  `src/renderer/src/components/pages/HomePage.tsx`,
  `src/renderer/src/components/accounts/AccountCard.tsx`,
  `src/renderer/src/components/accounts/AccountListRow.tsx`,
  `src/renderer/src/components/accounts/_helpers.ts`,
  `src/renderer/src/components/proxy/AccountSelectDialog.tsx`,
  `src/renderer/src/components/accounts/AddAccountDialog.tsx`,
  `src/renderer/src/components/pages/SubscriptionPage.tsx`,
  `src/renderer/src/components/pages/RegisterPage.tsx`.
- Phone:
  `src/webPanel/ui/format.ts`,
  `src/webPanel/ui/AccountCard.tsx`.
- Tests: add an architecture guard that allows raw suspension markers only in the
  authoritative normalizer, legacy migration, and test fixtures.

**Conflict notes**

- Depends on Step 1, and should follow Step 2 so recovery UI does not land against a
  disappearing boolean helper.
- Once the model is merged, backend consumers, desktop consumers, and panel
  consumers can be three parallel work packets. Do not give two workers
  `src/main/index.ts` or renderer `store/accounts.ts`.
- `autoSwitch.ts` and panel files changed in the recent headless work; rebase and
  preserve their current single-flight/revision behavior.

**Proof of work**

- A single table fixture drives producer tests and every consumer selector. The
  exact divergence matrix above becomes regression data.
- Architecture test fails if production UI/business code adds
  `AccountSuspendedException`, `TEMPORARILY_SUSPENDED`, generic `suspended`,
  Chinese ban keywords, or numeric-423 ban regexes outside the allowlist.
- Cross-surface contract test proves one account yields the same restriction state
  in main scheduler, pool admission, desktop store, selector dialog, and phone DTO.
- Negative tests prove `fetch failed`, `network`, token expiry, 429, and an unrelated
  message containing `423` are not restrictions.
- Full `npm test`, `npm run typecheck`, desktop build, and web-panel build pass.

## Human decisions required

1. **Unknown-code policy.** Approve keeping `ACCOUNT_SUSPENDED`,
   `AccountSuspendedException`, `ACCOUNT_LOCKED`, generic `suspended`, and
   `Disabled` as `duration:'unknown'` until measured evidence exists, instead of
   preserving the current unsupported “all require support” claim.
2. **Temporary retry policy.** Choose manual-only recheck for the first release, or
   authorize controlled automatic probes (including initial delay, exponential
   backoff, maximum cadence, and traffic budget). There is no evidence for a fixed
   upstream TTL (`recon-suspension-recovery.md:131-135`).
3. **Permanent/unknown override.** Decide whether advanced users may force a local
   clear without a successful probe. Recommendation: no; if allowed, it must be
   explicitly labelled as a temporary local override and must not claim upstream
   recovery.
4. **Legacy migration window.** Decide how long to dual-read old `lastError`-only
   records before deleting fallback parsing. Recommendation: one release plus an
   explicit schema version.
5. **Support UX.** Confirm the support URL and which codes should display it. The
   desktop currently shows the same AWS Support link for every locally classified
   ban (`src/renderer/src/components/accounts/AccountCard.tsx:922-946`), but the
   repository contains no evidence that every generic/temporary/locked state needs
   that route.
6. **Recovery telemetry/privacy.** Approve recording restriction code and
   first/last/recovered timestamps (without tokens or full upstream body) so a later
   report can answer the currently unverified recovery-timescale question with real
   data.

Everything else above — type placement, route wiring, persistence, concurrency
guards, migration implementation, and tests — is an engineering decision once these
policy choices are fixed.
