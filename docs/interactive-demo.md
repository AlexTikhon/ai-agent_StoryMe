# Interactive story demo

A reproducible walkthrough of the interactive illustrated-story product, in two parts:

1. **Published reader** — start "The Last Delivery", make choices, reload and resume, reach an
   ending.
2. **Mock draft** — author the unpublished "The Last Tram" offline, play both of its endings, and
   watch publication preflight reject it because no human has approved it.

Everything here uses deterministic mock components. There are no network calls, no paid provider
calls, and nothing is published. Commands are Windows PowerShell and run from the repository root.
For what the product implements and its limits, see
[CURRENT_PRODUCT.md](CURRENT_PRODUCT.md#interactive-illustrated-stories).

## Part 1: published reader

### Set up

The reader needs the same setup as the book demo — [local-demo.md](local-demo.md) steps 1–6 — except
that **no generation worker is needed**. PostgreSQL and Redis are required (Redis holds the request
budgets, which fail closed).

```powershell
pnpm install
docker compose up -d postgres redis
if (-not (Test-Path apps\api\.env)) { Copy-Item .env.example apps\api\.env }
pnpm --filter @book/api prisma:migrate:deploy
pnpm --filter @book/api dev        # terminal 1: http://localhost:4000
pnpm --filter @book/web dev        # terminal 2: http://localhost:3000
```

This is your normal local development database. The account and sessions you create stay in it;
the product has no session deletion (see Cleanup).

### Walk through

Open <http://localhost:3000/register> and create an account (JWT mode is the default; see
[local-demo.md §7](local-demo.md#7-sign-in)). Then:

| #   | Action                                                    | Expected result                                                                                       |
| --- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1   | Click **Interactive story** in the dashboard header       | `/dashboard/interactive` shows a "The Last Delivery" card and an empty "Your stories" list            |
| 2   | Click **Start story**                                     | URL becomes `/dashboard/interactive/<session-id>`; scene "Praga courtyard" with an illustration       |
| 3   | Choose **Ask the caretaker where Tomasz is**              | Scene "The caretaker's broom"; **Carrying** lists "Single-use entry card"                             |
| 4   | **Reload the page**                                       | Same scene and same card. No new session is created; the reader fetched the stored state              |
| 5   | Choose **Climb to the fourth floor**                      | Scene "Flat 4"                                                                                        |
| 6   | Choose **Use the single-use entry card on the lock**      | Scene "Inside flat 4"; the card disappears from **Carrying** (a one-time item is consumed)            |
| 7   | Choose **Take the service stairs down to the cellar**     | Scene "The cellar workshop"                                                                           |
| 8   | Choose **Carry the original ledger up and confront Ines** | Ending "The Ledger Exposed"; no more choices; a **Start another story** link appears                  |
| 9   | Click **← Interactive story**                             | "Your stories" lists one entry, "Completed", "Ending: The Ledger Exposed", with a **Read again** link |

Optional checks:

- **The other ending.** Start another story and choose **Check the mailboxes by the stairwell**, then
  **Climb to the fourth floor**, then **Slip a delivery slip under the door and leave the parcel**.
  It ends at "A Quiet Delivery". Choices such as using the entry card are not offered on this route
  because the earlier choice that grants the card was never made.
- **Revision conflict.** Open the same session URL in a second tab and advance the story there.
  Back in the first tab, click a choice from the old scene. The reader explains that the story moved
  on, shows the current scene, and applies nothing on your behalf.
- **Rate limit.** Starting more than five stories in ten minutes returns `429 RATE_LIMITED`
  (`INTERACTIVE_CREATE_RATE_LIMIT_*`, a private-pilot default).

### Automated coverage

The browser suite plays these journeys (both endings, reload and resume, ownership, cross-tab
conflict, lost-response retries, illustrations, desktop and mobile layout) against a real API on a
**disposable** PostgreSQL/Redis pair. It is guarded: Playwright replaces the database settings and
the launcher refuses any target other than `127.0.0.1:5440/storyme_e2e` and Redis
`127.0.0.1:6380/15`, so it cannot touch the development database. Docker must be running.

```powershell
pnpm test:infra:up
pnpm --filter @book/web test:e2e e2e/interactive.spec.ts
pnpm test:infra:down
```

`test:infra:down` removes the containers and volumes of that named disposable project only. The
suite uses web port 3100 and API port 4100; see [E2E_TESTING.md](E2E_TESTING.md). The full-suite
command `pnpm test:e2e:home` runs every spec, not just the interactive one.

### Clean up the reader demo

Stop both dev servers (Ctrl+C). `docker compose down` stops PostgreSQL and Redis and keeps their data.
To drop the demo account and sessions, use a throwaway account, or remove the volumes with
`docker compose down -v` — **which deletes all local development data**, so only do that if you do
not need it.

## Part 2: mock draft walkthrough

This part needs no database, Redis, network or API key. It writes only into a temporary directory and
reads that directory afterwards; it changes nothing under `apps/`.

### 1. Author the candidate

```powershell
$drafts = Join-Path $env:TEMP 'storyme-interactive-demo\scenario-drafts'
New-Item -ItemType Directory -Force $drafts | Out-Null
pnpm --silent author:interactive --mode mock --drafts-root $drafts
```

The drafts root must be named `scenario-drafts`. Expected output, abridged (the artifacts line and
run directory name differ per run):

```text
Mode: mock (offline, deterministic, no network)
Call budget: at most 2 requests / 2 HTTP attempts (1 generation + 1 repair)
Result: REVIEW_REQUIRED (mechanically valid; NOT approved, NOT published)
Candidate: warsaw-last-tram@1 hash=<64 hex characters>
Requests: 1, HTTP attempts: 0
Files: validated-candidate.json, validation-report.json, review-report.md, approval-template.json
```

The mock candidate is deterministic, so the hash is the same on every run at a given commit. A later
edit to the episode changes it. `REVIEW_REQUIRED` means mechanically valid, not approved.

Locate the artifacts and snapshot them so you can prove they are not modified later:

```powershell
$run  = Get-ChildItem $drafts -Directory -Filter '*--review-required' | Select-Object -First 1
$cand = Join-Path $run.FullName 'validated-candidate.json'
$appr = Join-Path $run.FullName 'approval-template.json'
$before = Get-ChildItem $run.FullName | Get-FileHash | ForEach-Object { "$($_.Hash) $(Split-Path $_.Path -Leaf)" }
```

Open `$run\review-report.md`: it lists the witness route to each ending and the editorial checklist a
person must complete. `$appr` has `"decision": "pending"`, no reviewer and every checklist item
`false`.

### 2. Play both endings

The playtest drives the production engine over the candidate file and only reads it.

```powershell
# Quiet ending
pnpm --silent playtest:interactive --candidate $cand --choices 'c-inspect-carriage,c-pocket-receipt,c-show-receipt,c-let-hanna-repay'
# Report ending
pnpm --silent playtest:interactive --candidate $cand --choices 'c-ask-driver,c-leave-cab,c-open-panel,c-report-to-depot'
```

Expected final lines of each run:

```text
Result: PLAYTEST_COMPLETED ending=quiet-repayment
Route: c-inspect-carriage, c-pocket-receipt, c-show-receipt, c-let-hanna-repay
Playtest only: nothing was approved, registered or published.
```

```text
Result: PLAYTEST_COMPLETED ending=report-filed
Route: c-ask-driver, c-leave-cab, c-open-panel, c-report-to-depot
Playtest only: nothing was approved, registered or published.
```

A route that stops early is never reported as completed:

```powershell
pnpm --silent playtest:interactive --candidate $cand --choices 'c-ask-driver'
```

```text
Result: PLAYTEST_INCOMPLETE (no ending was reached)
the route stopped before reaching an ending
Route: c-ask-driver
```

To play by hand instead, omit `--choices`: it shows numbered choices, and `q` quits.

Notes for PowerShell:

- Quote the comma-separated `--choices` value. Unquoted, PowerShell passes an array and the run fails
  with `PLAYTEST_FAILED [ROUTE_MALFORMED]`.
- Use absolute paths. `pnpm` runs these scripts from `apps\api`, so a repo-relative path would
  resolve against that directory.
- Through `pnpm`, every non-zero script exit shows as `1`. The documented exit codes (`3` for
  incomplete, `4` for cancelled) appear only when the script runs directly; the `Result:` line is
  the reliable signal. See [Offline playtest](../apps/api/docs/interactive-authoring.md#offline-playtest).

### 3. Preflight rejects the pending approval

```powershell
pnpm --silent preflight:interactive --candidate $cand --approval $appr
```

```text
Interactive publication preflight (read-only)
Result: PUBLICATION_PREFLIGHT_FAILED [APPROVAL_PENDING]
approval is still pending
```

Preflight re-runs every mechanical check and recomputes the hash, then refuses because the approval
record is not an approved, complete, hash-bound human attestation. The tooling never writes one. The
specification of an approval record and of the rest of the publication sequence is in
[interactive-authoring.md](../apps/api/docs/interactive-authoring.md#publication-boundary-manual-sequence).
This demo deliberately does not fabricate an approval.

### 4. Confirm nothing changed and nothing was published

```powershell
$after = Get-ChildItem $run.FullName | Get-FileHash | ForEach-Object { "$($_.Hash) $(Split-Path $_.Path -Leaf)" }
"Artifacts unchanged: $(-not (Compare-Object $before $after))"
```

Expected: `Artifacts unchanged: True`. "The Last Tram" is also absent from the web app: the catalogue
(`GET /api/interactive/scenarios`) and the **Interactive story** page list only "The Last
Delivery", because the static registry does not contain the draft, and session creation for it
returns `422 UNKNOWN_SCENARIO` ([engine document](../apps/api/docs/interactive-engine.md#catalogue)).

### Clean up the draft demo

```powershell
Remove-Item -Recurse -Force (Split-Path $drafts -Parent)
```

This removes only the temporary `storyme-interactive-demo` directory.

## What this demonstrates and what it does not

It demonstrates a deterministic, replayable runtime and an authoring workflow whose mechanical gates
and human gate are separate. It does not demonstrate real-model authoring (that mode needs
`--allow-paid-calls` and has never been run here, so its quality is unverified), prose quality
(mechanical validation cannot judge it), a deployed service, or generated artwork (the illustrations
are local SVG files). The trade-offs behind those choices are in
[CURRENT_PRODUCT.md](CURRENT_PRODUCT.md#design-trade-offs).
