# Hold Gate release accounting findings

## Result

The structural accounting defect inside `HoldGate` is fixed without editing `proxyServer.ts` or changing release scheduling / claim semantics.

- `HoldEpisode` now owns an untruncated `totalReleaseCount`.
- It also owns `totalAutoReleaseCount`, the auto-trigger subset used to derive the existing session-level `getAutoReleaseCount()` contract.
- Every successful release trigger reaches the same `recordRelease()` accounting point.
- The timer no longer increments a separate counter before calling `releaseAll('auto')`.
- `releases` remains capped at 50 display records.
- When the 20-episode display cap evicts an episode, only that episode's already-computed auto total is folded into `discardedEpisodeAutoReleaseCount`; the session getter remains accurate without retaining an unbounded episode list.
- `resetSessionState()` clears current/recent episodes and the folded discarded total.

## Red → green evidence

Red command:

```text
npx vitest run test/main/proxy/holdGateTimeline.test.ts --reporter=default --reporter=json --outputFile.json=.agent-workspace/.archive/2026-08-13/fix-hold-counter/red.json
```

Observed before implementation:

```text
单个episode的release超过50条_展示丢最旧但总数保持准确
AssertionError: expected undefined to be 60
numPassedTests=15
numFailedTests=1
EXIT=1
```

This failed for the intended reason: after 60 release cycles the bounded display still had 50 rows, but the episode had no independent total.

Green command:

```text
npx vitest run test/main/proxy/holdGate.test.ts test/main/proxy/holdGateTimeline.test.ts test/main/proxy/holdReleaseObservability.test.ts test/main/proxy/holdGateSessionLifecycle.test.ts --reporter=default --reporter=json --outputFile.json=.agent-workspace/.archive/2026-08-13/fix-hold-counter/green-owned.json
```

Observed after implementation:

```text
Test Files 4 passed (4)
Tests 61 passed (61)
numPassedTests=61
numFailedTests=0
EXIT=0
```

The 60-cycle regression now asserts both `releases.length === 50` and `totalReleaseCount === 60`. A second cap regression creates 25 completed auto-release episodes, retains 20 display episodes, and still reads a session cumulative auto count of 25.

Type verification:

```text
npm run typecheck:node
EXIT=0
```

Temporary JSON reporter files were deleted after their counts were read.

## Release-trigger audit

All real release actions now account through `recordRelease(trigger, released)`:

1. Automatic timer: `startAutoReleaseIfNeeded()` calls `releaseAll('auto')`; the old pre-call `autoReleaseCount++` was removed.
2. Manual release: `releaseAll()` defaults to `manual` and records through the same point.
3. Pool-availability resume: `tryResume()` defaults to `pool-available` and records through the same point after the availability guard succeeds.
4. Fallback poll: the poll timer calls `tryResume('poll')`, which uses the same point after the pool becomes available.

Tests now assert `totalReleaseCount === 1` for `auto`, `manual`, `pool-available`, and `poll`. A poll tick while the pool is unavailable is not a release action and intentionally remains uncounted.

No release timing, interval, pool-availability guard, `claim()` CAS behavior, or held-entry removal was changed.

## Consumer audit and required propagation

Semantic search used all three requested indexes (`codegraph`, `codebase-context-engine`, and `fast-context`) before checking concrete symbols.

Checked producer / transport:

- `src/main/proxy/proxyServer.ts`: `buildHeldRequestsInfo()` passes `holdGate.getTimeline()` episode objects through unchanged. `getHoldAutoReleaseState()` can keep calling `getAutoReleaseCount()` because that getter now derives its result from episode totals. **No `proxyServer.ts` follow-up line is required.**
- `src/main/ipc/panelProxyDeps.ts`: `PanelProxyStatus` references `HoldEpisode` directly, so the new fields are present in the runtime phone-panel response without an adapter change.

Checked desktop consumer:

- `src/renderer/src/components/proxy/ProxyPanel.tsx` has a local `HoldEpisodeView` DTO that omits the new totals.
- Its episode summaries and row ordinals still use `ep.releases.length`.

Checked phone consumer:

- `src/webPanel/api/panel.ts` has a separate `PanelHoldEpisode` DTO that omits the new totals.
- `src/webPanel/ui/ProxyPanel.tsx` still numbers / summarizes releases from `ep.releases.length`.

Those desktop and phone edits are outside this task's explicit file ownership. They require a sequenced follow-up to add `totalReleaseCount` (and, if the auto subset is displayed, `totalAutoReleaseCount`) to the local DTOs, use `totalReleaseCount` for episode summaries, and offset displayed row ordinals so retained rows 11–60 are not mislabeled 1–50. Until that follow-up lands, the backend/API is structurally correct and the top-level auto cumulative remains correct, but both timeline UIs will still visually say 50 for a 60-release episode.

## Rejected approaches

- Keeping `autoReleaseCount++` in the timer and only adding an episode field: rejected because it preserves call-order coupling and misses manual / pool / poll releases.
- Computing totals from `releases.length`: rejected because the array is deliberately capped at 50.
- Removing the 50-row or 20-episode caps: rejected because it creates unbounded server memory growth.
- Summing only retained episodes for the session auto count: rejected because the 21st completed episode would recreate the same drift at a different cap.
- Counting release entries / resumed requests instead of release actions: rejected because one release cycle may atomically resume multiple held requests; existing product semantics count cycles, not entries.
- Moving accounting into `claim()`: rejected because `claim()` is per held request and is also used by timeout / abort; it would inflate counts and alter load-bearing CAS semantics.
