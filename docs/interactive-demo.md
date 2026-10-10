# Interactive story demo

A reproducible walkthrough of the interactive illustrated-story product, in two parts:

1. **Published reader** — start "The Last Delivery", make choices, reload and resume, reach an
   ending.
2. **Mock draft** — author the unpublished "The Last Tram" offline, play both of its endings, and
   watch publication preflight reject it because no human has approved it.

Everything here uses deterministic mock components. There are no external provider calls and no paid
calls, and nothing is published. (The reader in Part 1 makes ordinary local HTTP requests between the
web app and the API on your machine.) Commands are Windows PowerShell and run from the repository root.
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

This part needs no database, Redis, network access or API key once dependencies are installed
(`pnpm install`). Each invocation creates its own fresh temporary directory and writes only there; it
changes nothing under `apps/`. Run the steps in order in one PowerShell session, because they share
variables. Steps 2–4 stop immediately if step 1 did not finish.

### 1. Author the candidate

Create a new, uniquely named demo root for this invocation, then author into a `scenario-drafts`
child of it (the authoring tool requires that exact name). Nothing from an earlier invocation is
reused, so an older run can never be mistaken for this one.

```powershell
# Forget anything left over from an earlier invocation in this session.
$demo = $drafts = $out = $run = $cand = $appr = $before = $null

$demo = Join-Path ([IO.Path]::GetTempPath()) ('storyme-interactive-demo-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $demo | Out-Null   # no -Force: fails if it already exists
Set-Content -LiteralPath (Join-Path $demo '.storyme-demo-owner') -Value 'created by docs/interactive-demo.md'
$drafts = Join-Path $demo 'scenario-drafts'
New-Item -ItemType Directory -Path $drafts | Out-Null

$out = pnpm --silent author:interactive --mode mock --drafts-root $drafts
$code = $LASTEXITCODE
$out = @($out | ForEach-Object { "$_" })
$out
if ($code -ne 0) { throw "Authoring failed (exit $code); no artifacts were selected." }
```

Expected output, abridged (the hash is the same on every run at a given commit; the `Artifacts:`
path differs per run):

```text
Mode: mock (offline, deterministic, no network)
Call budget: at most 2 requests / 2 HTTP attempts (1 generation + 1 repair)
Result: REVIEW_REQUIRED (mechanically valid; NOT approved, NOT published)
Candidate: warsaw-last-tram@1 hash=<64 hex characters>
Requests: 1, HTTP attempts: 0
Artifacts: <demo root>\scenario-drafts\<timestamp>-warsaw-last-tram-v1-<hex>--review-required
Files: validated-candidate.json, validation-report.json, review-report.md, approval-template.json
```

A later edit to the episode changes the hash. `REVIEW_REQUIRED` means mechanically valid, not
approved.

Now select the run this invocation created. The `Artifacts:` line printed by the authoring tool names
the run; the check then confirms it is the only entry in the fresh drafts folder and holds exactly the
four expected files. Directory ordering is never used to choose a run, and an absent or ambiguous
result stops here.

```powershell
$names = 'validated-candidate.json', 'validation-report.json', 'review-report.md', 'approval-template.json'
$lines = @($out | Where-Object { $_ -like 'Artifacts: *' })
if ($lines.Count -ne 1) { throw "Expected exactly one 'Artifacts:' line, found $($lines.Count)." }
$printed = Split-Path -Leaf $lines[0].Substring('Artifacts: '.Length).Trim()
$entries = @(Get-ChildItem -LiteralPath $drafts -Force)
if ($entries.Count -ne 1) { throw "Expected exactly one run in the fresh drafts folder, found $($entries.Count)." }
if ($entries[0].Name -ne $printed -or -not $entries[0].PSIsContainer -or $printed -notlike '*--review-required') {
  throw "The run on disk ('$($entries[0].Name)') is not the reported REVIEW_REQUIRED run ('$printed')."
}
$files = @(Get-ChildItem -LiteralPath $entries[0].FullName -Force | ForEach-Object Name | Sort-Object)
if (($files -join '|') -ne (($names | Sort-Object) -join '|')) { throw "Unexpected artifact set: $($files -join ', ')" }

$run  = $entries[0]
$cand = Join-Path $run.FullName 'validated-candidate.json'
$appr = Join-Path $run.FullName 'approval-template.json'
```

Snapshot the four artifacts so you can prove they are not modified later:

```powershell
$snapshot = { Get-ChildItem -LiteralPath $run.FullName -Force | Sort-Object Name | Get-FileHash -Algorithm SHA256 | ForEach-Object { "$($_.Hash) $(Split-Path -Leaf $_.Path)" } }
$before = @(& $snapshot)
$before
```

Open `$run\review-report.md`: it lists the witness route to each ending and the editorial checklist a
person must complete. `$appr` has `"decision": "pending"`, no reviewer and every checklist item
`false`.

### 2. Play both endings

The playtest drives the production engine over the candidate file and only reads it.

```powershell
if (-not $cand -or -not $before) { throw 'Step 1 did not select a run; stop.' }
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
if (-not $cand) { throw 'Step 1 did not select a run; stop.' }
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
if (-not $cand -or -not $appr) { throw 'Step 1 did not select a run; stop.' }
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
if (-not $before) { throw 'Step 1 did not select a run; stop.' }
$after = @(& $snapshot)
"Artifacts unchanged: $(($before.Count -eq 4) -and (($before -join '|') -ceq ($after -join '|')))"
```

Expected: `Artifacts unchanged: True`, comparing the SHA-256 hashes of the four artifacts of this
invocation's run. "The Last Tram" is also absent from the web app: the catalogue
(`GET /api/interactive/scenarios`) and the **Interactive story** page list only "The Last
Delivery", because the static registry does not contain the draft, and session creation for it
returns `422 UNKNOWN_SCENARIO` ([engine document](../apps/api/docs/interactive-engine.md#catalogue)).

### Clean up the draft demo

Remove the demo root only after checking that it is the directory this invocation created: a real
directory (not a link) directly under the temporary directory, with the generated name and the
ownership marker file written in step 1.

```powershell
if (-not $demo) { throw 'No demo root in this session; nothing to remove.' }
$tempRoot = (Get-Item -LiteralPath ([IO.Path]::GetTempPath())).FullName.TrimEnd('\')
$target = Get-Item -LiteralPath $demo -Force -ErrorAction Stop
$owned = $target.PSIsContainer -and
  -not $target.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint) -and
  $target.Parent.FullName.TrimEnd('\') -eq $tempRoot -and
  $target.Name -match '^storyme-interactive-demo-[0-9a-f]{32}$' -and
  (Test-Path -LiteralPath (Join-Path $target.FullName '.storyme-demo-owner') -PathType Leaf)
if (-not $owned) { throw "Refusing to delete '$demo': it is not this demo's temporary root." }
Remove-Item -LiteralPath $target.FullName -Recurse -Force
```

This removes only this invocation's demo root. Roots left by earlier invocations (for example after a
failed step) are separate directories under the temporary directory named
`storyme-interactive-demo-<32 hex characters>`; remove each the same way, after confirming its path.

## What this demonstrates and what it does not

It demonstrates a deterministic, replayable runtime and an authoring workflow whose mechanical gates
and human gate are separate. It does not demonstrate real-model authoring (that mode needs
`--allow-paid-calls` and has never been run here, so its quality is unverified), prose quality
(mechanical validation cannot judge it), a deployed service, or generated artwork (the illustrations
are local SVG files). The trade-offs behind those choices are in
[CURRENT_PRODUCT.md](CURRENT_PRODUCT.md#design-trade-offs).
