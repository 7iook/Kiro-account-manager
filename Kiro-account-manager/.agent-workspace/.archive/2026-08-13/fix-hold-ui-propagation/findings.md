# Hold episode UI contract propagation

## Result

The desktop and phone hold timelines now consume the untruncated episode totals instead of treating the bounded `releases` display array as accounting state.

- Both local episode DTOs now include `totalReleaseCount` and `totalAutoReleaseCount`.
- Current and recent episode summaries use `totalReleaseCount`.
- Retained release rows are newest-first and numbered from the real total. A 60-release episode whose retained rows are releases 11–60 therefore renders `#60` through `#11`, not `#50` through `#1`.
- When rows were discarded, both UIs explicitly say that only the latest retained rows are shown and how many earlier rows were omitted. Chinese text is identical: `仅显示最近 50 条，前 10 条已省略`; the desktop English equivalent is `Showing the latest 50; 10 earlier releases omitted`.

## Consumer enumeration

All three requested current-disk semantic indexes were used before concrete symbol checks: `codegraph-codegraph_explore`, `codebase-context-engine-search_context`, and `fast-context-fast_context_search`.

1. `src/main/proxy/holdGate.ts`
   - Contract owner and producer of `HoldEpisode`.
   - Already correct: owns untruncated `totalReleaseCount` / `totalAutoReleaseCount`; caps only `releases`.
   - Not edited (outside ownership).
2. `src/main/proxy/proxyServer.ts`
   - Producer/transport bridge through `buildHeldRequestsInfo()`.
   - Already correct: passes episode objects through unchanged.
   - Not edited (outside ownership).
3. `src/main/ipc/panelProxyDeps.ts`
   - Phone-panel transport DTO.
   - Already correct: `PanelProxyStatus` references the real `HoldEpisode` type.
   - Not edited (outside ownership).
4. `src/renderer/src/components/proxy/ProxyPanel.tsx`
   - Desktop local `HoldEpisodeView` mirror and timeline renderer.
   - Fixed both totals, summaries, row ordinals, and truncation disclosure.
5. `src/webPanel/api/panel.ts`
   - Phone-panel local `PanelHoldEpisode` mirror.
   - Fixed both totals.
6. `src/webPanel/ui/ProxyPanel.tsx`
   - Phone timeline renderer.
   - Fixed summaries, row ordinals, and truncation disclosure.
7. Existing producer/transport tests under `test/main/proxy/**`, `test/main/ipc/panelProxyDeps.test.ts`, and `test/main/webPanel/proxyRoutes.test.ts`
   - They exercise the upstream accounting and transport paths; no owned production edit was needed.
8. UI regression consumers:
   - `test/renderer/web-panel-ui/panelProxyPanel.test.tsx` now sends the fields through the real phone fetch/API boundary and asserts total, disclosure, and `#60`/`#11` ordinals.
   - `test/renderer/holdTimeline.test.tsx` directly renders the desktop timeline with the same transported shape and asserts the same behavior.

No additional `HoldEpisode` consumer deriving accounting from `releases.length` was found. Remaining `releases.length` uses in the two UIs are display-window operations only: empty-list detection, omitted-row calculation, and disclosure of retained row count.

## DTO drift audit

Compared with `src/main/proxy/holdGate.ts`:

- `HoldEpisodeView` now has every `HoldEpisode` field with matching required/nullability/union shapes.
- `PanelHoldEpisode` now has every `HoldEpisode` field with matching required/nullability/union shapes.
- `HoldReleaseView` and `PanelHoldRelease` already matched `HoldRelease`; no other drift was found.

## Red → green evidence

Red:

```text
npx vitest run test/renderer/web-panel-ui/panelProxyPanel.test.tsx --reporter=default --reporter=json --outputFile.json=.agent-workspace/.archive/2026-08-13/fix-hold-ui-propagation/red-phone.json
EXIT=1
numPassedTests=22
numFailedTests=1
Unable to find an element with the text: 已放行 60 次
```

The failure was for the intended old behavior: the UI rendered the retained array length rather than the transported total.

Final green:

```text
npx vitest run test/renderer/holdTimeline.test.tsx test/renderer/web-panel-ui/panelProxyPanel.test.tsx --reporter=default --reporter=json --outputFile.json=.agent-workspace/.archive/2026-08-13/fix-hold-ui-propagation/green-ui.json
EXIT=0
Test Files 2 passed (2)
Tests 24 passed (24)
numPassedTests=24
numFailedTests=0
```

Type verification:

```text
npm run typecheck:node
EXIT=0

npm run typecheck:web
EXIT=0
```

The temporary JSON reporter files were read for counts and then deleted.

## Rejected approaches

- Removing the 50-row cap: rejected because the cap is intentional bounded-memory/display behavior; accounting must not depend on removing it.
- Numbering retained rows `1..50`: rejected because those rows are releases `11..60` in the regression case and false ordinals would miscorrelate timestamps with logs.
- Showing only `60 releases` above 50 rows: rejected because it makes the bounded list look complete. Both UIs now disclose the retained and omitted counts beside the rows.
- Reconstructing the total from `releases.length`: rejected because the backend contract now provides the authoritative untruncated total and the array is deliberately lossy.
- Introducing a shared frontend abstraction for two different application bundles: rejected as unnecessary coupling for three simple display calculations; each existing consumer now reads the same wire contract directly.
