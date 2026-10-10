# The Last Tram — editorial consistency review (Phase 7.3)

**Status: `REVIEW_REQUIRED`. Not human-approved, not registered, not published.** This is an assisted editorial revision of the mock candidate in `src/interactive/authoring/the-last-tram.ts`. It is not approval: `SCENARIO_APPROVALS` stays empty, the approval template stays `pending`, and publication preflight still fails with `APPROVAL_PENDING`. Real-model quality is not claimed; this is the bundled mock episode only.

- Candidate: `warsaw-last-tram@1`
- Revised canonical hash: `7eba089e687c9b1567ef480575df62bac5f7f9fce0cfd257ce2a2015aa3c3d1e`
- Any later edit changes the hash and restarts review.

## Route matrix

The gameplay graph is unchanged. There are exactly five terminal routes (enumerated from the production engine and each replay-verified in `the-last-tram.spec.ts`; each was also played through `pnpm playtest:interactive`).

| # | Route (choice ids after the opening) | Box | Borrowing known | Ending |
| - | ------------------------------------ | --- | --------------- | ------ |
| 1 | `c-ask-driver, c-leave-cab, c-open-panel, c-report-to-depot` | recovered | no | report-filed |
| 2 | `c-ask-driver, c-leave-cab, c-wait-for-terminus, c-report-to-depot` | missing | no | report-filed |
| 3 | `c-inspect-carriage, c-pocket-receipt, c-show-receipt, c-report-to-depot` | missing | yes (Hanna confessed) | report-filed |
| 4 | `c-inspect-carriage, c-pocket-receipt, c-show-receipt, c-let-hanna-repay` | missing | yes | quiet-repayment |
| 5 | `c-inspect-carriage, c-pocket-receipt, c-wait-for-terminus, c-report-to-depot` | missing | no | report-filed |

`c-let-hanna-repay` is available only after `f-hanna-borrowed` is known, so only route 4 reaches the quiet ending.

## Findings addressed

1. **Premature attribution (route 1).** The panel line said the box sat "where Hanna left it", but on this route Nina only knows Wiktor saw Hanna near the panel. Now it states only what Nina did and found. Wiktor's key line now gives a reason for the key ("in case you want a look behind that panel") rather than handing it over unexplained.
2. **Report label (all routes).** "Report the missing box" was false after recovery. Now "File an incident report with the depot supervisor". The brief's ending concept was aligned.
3. **Report ending ignored what happened.** Added two conditional lines: a recovered-box line (route 1; says how the box got there is for the supervisor to ask) and a confession line (route 3; records Hanna's account and that the box is still missing).
4. **Ambiguous "it" in the confession.** Hanna now says she meant to borrow "the money".
5. **Wiktor knowing the borrowing without being present.** The engine gives him that knowledge in route 3/4. The terminus line now shows him listening in his mirror.
6. **Show-receipt label.** Now includes asking about the shortfall, so Hanna's response is motivated.
7. **Opening timeline.** "At the last stop" contradicted the fact "between two stops". Now "earlier tonight … somewhere between two stops".
8. **Quiet ending asserted the outcome and left the box dangling.** The scene title "Paid back by morning" is now "Until morning", and Hanna promises both box and money.

## Checks

- `the-last-tram.spec.ts` pins which narration templates and choices each route may show (recovered or unrecovered box, known or unknown confession, quiet-ending gating). It asserts template ids and label content, not prose snapshots, and is not a consistency detector.
- No validation was weakened; validator, engine and playtest runner are untouched.

## Remaining human-review questions

- Route 1 never explains how the box got behind the panel. Is leaving that to the supervisor satisfying, or does the draft need a clue?
- Routes 3–4: the box stays unfound and only Hanna's closing promise covers it. Is that acceptable for a "quiet" ending?
- Timeline: Wiktor's ninth-stop sighting versus Nina boarding at the Wola loop is only loosely reconciled.
- Why does Wiktor hold a panel key and lend it off the record? Is that in character?
- Pacing, tone, audience suitability and originality are untouched by this pass and still need the full editorial checklist.
