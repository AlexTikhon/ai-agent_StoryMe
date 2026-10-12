# Interactive story demo

A reproducible walkthrough of the interactive illustrated-story product, in three parts:

1. **Published reader** — start "The Last Delivery", make choices, reload and resume, reach an
   ending, then reread the finished story page by page with its illustrations.
2. **Mock draft** — author the unpublished "The Last Tram" offline, play both of its endings, and
   watch publication preflight reject it because no human has approved it.
3. **Offline authoring experiment** — run the three-brief experiment workflow with scripted
   fixtures, inspect the saved manifest, and read the comparison report without mistaking a scripted
   pass for model performance.

Everything here uses deterministic mock or scripted components. There are no external provider calls
and no paid calls, and nothing is published. (The reader in Part 1 makes ordinary local HTTP requests
between the web app and the API on your machine.) Commands are Windows PowerShell and run from the
repository root.
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

This is your normal local development database. The account and sessions you create stay in it.
**Remove** hides a story and frees its place under the per-user cap, but the stored rows are
retained: nothing in the product erases them (see [Remove a story](#remove-a-story) and
[Clean up the reader demo](#clean-up-the-reader-demo)).

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

### Reread the finished story

Continue from step 9, with "Your stories" open. Rereading reads the history stored for the completed
session. It creates no session and submits no choice, so the list still shows one story afterwards.

| #   | Action                                                  | Expected result                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 10  | Click **Read again** on the completed story             | URL becomes `/dashboard/interactive/<session-id>/transcript`; heading "Read again", story title "The Last Delivery", and "Showing 3 of 6 chapters."                                                                                                                |
| 11  | Read the three chapters shown                           | "Chapter 1 Praga courtyard" (no choice label); "Chapter 2 The caretaker's broom", "You chose: Ask the caretaker where Tomasz is"; "Chapter 3 Flat 4", "You chose: Climb to the fourth floor". Each chapter shows its own illustration. No ending card yet          |
| 12  | Click **Load more**                                     | Chapters 4–6 follow: "Inside flat 4" ("You chose: Use the single-use entry card on the lock"), "The cellar workshop" ("You chose: Take the service stairs down to the cellar"), "The ledger exposed" ("You chose: Carry the original ledger up and confront Ines") |
| 13  | Read the end of chapter 6                               | A "The end" card titled "The Ledger Exposed" with its summary; "All 6 chapters, from the beginning to the end."; no **Load more** button                                                                                                                           |
| 14  | **Reload the page**                                     | Rereading starts again at the first page: "Showing 3 of 6 chapters." and chapters 1–3 only. The loaded pages reset; the completed session and its stored history are unchanged                                                                                     |
| 15  | Click **Load more** again                               | Chapters 4–6 and the "The end" card return, and **Back to the ending** and **Start another story** appear again (they are shown only once the whole transcript has loaded). **← Interactive story** is available throughout                                        |
| 16  | Click **Back to the ending** or **← Interactive story** | **Back to the ending** returns to the finished reader at `/dashboard/interactive/<session-id>`; **← Interactive story** returns to the catalogue                                                                                                                   |

The exposed route has six chapters because it makes five choices (the opening scene plus one chapter
per choice); the quiet route below makes three choices and has four. The page requests three chapters
at a time, so even the four-chapter route needs **Load more**. From the finished reader, the **Read
the story from the beginning** link opens the same page.

The text of each chapter and every "You chose" label come from the responses saved when the story was
played, so they cannot change if the scenario files are edited later. The pictures are different:
they are looked up when the page is read from the illustration pack for that scenario version. Today
that is the same local pack the reader used, but rereading does not record or prove which picture
was shown at the time.

Illustrations are fetched separately from the text, one request per page of chapters, and a failure
never blocks reading. If a metadata request fails or is rejected, or an image file cannot be loaded,
the affected chapters show no picture (a note and **Reload illustration** where a retry is allowed),
while the text and **Load more** keep working. The automated suite below exercises these failures with
browser-injected faults; this walkthrough does not ask you to cause them.

Optional checks:

- **The other ending.** Start another story and choose **Check the mailboxes by the stairwell**, then
  **Climb to the fourth floor**, then **Slip a delivery slip under the door and leave the parcel**.
  It ends at "A Quiet Delivery". Choices such as using the entry card are not offered on this route
  because the earlier choice that grants the card was never made. Click **Read again** on it: the
  page shows "Showing 3 of 4 chapters.", then after **Load more** "All 4 chapters, from the
  beginning to the end." with the chapters "Praga courtyard", "Behind the mailboxes", "Flat 4" and
  "A quiet delivery".
- **Unfinished stories.** Open `/dashboard/interactive/<session-id>/transcript` for a story you have
  not finished: the page says "Rereading comes after the ending" and offers **Continue the story**.
  The same URL for another account's session, or one that does not exist, says "This story isn't
  available".
- **Revision conflict.** Open the same session URL in a second tab and advance the story there.
  Back in the first tab, click a choice from the old scene. The reader explains that the story moved
  on, shows the current scene, and applies nothing on your behalf.
- **Rate limit.** Starting more than five stories in ten minutes returns `429 RATE_LIMITED`
  (`INTERACTIVE_CREATE_RATE_LIMIT_*`, a private-pilot default).

### Remove a story

Continue from step 16, back on the catalogue with "Your stories" open. Removal hides a story; it
does not erase what is stored for it.

| #   | Action                                                   | Expected result                                                                                                                                               |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 17  | Click **Remove** on the completed story, then **Cancel** | A confirmation says you can no longer read it again and that the stored data is not erased. Cancel closes it and focus returns to **Remove**; nothing is sent |
| 18  | Click **Remove**, then **Yes, remove story**             | The row stays until the server confirms, then disappears with "was removed from your stories"; the list is empty again                                        |
| 19  | **Reload the page**                                      | The story is still absent. Opening its `/dashboard/interactive/<session-id>` or `.../transcript` URL says "This story isn't available"                        |

Removing frees the story's place under the per-user cap. An unfinished story can be removed the
same way. If the answer is lost, the row stays with an "unconfirmed" message and **Try again** resends
the same request, which is safe because removal is idempotent. A reader left open in another tab
only finds out on its next request, then stops offering choices. The data is retained: there is no
restore, hard deletion or retention worker, so this is not privacy erasure.

### Automated coverage

The browser suite plays these journeys (both endings, reload and resume, ownership, cross-tab
conflict, lost-response retries, illustrations, desktop and mobile layout, paginated, illustrated
rereading of both endings including reload, ownership, unfinished stories and artwork failures, and
story removal including a lost acknowledgement and a creation retry for a removed story)
against a real API on a **disposable** PostgreSQL/Redis pair. It is guarded: Playwright replaces the database settings and
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

The workflow [ci.yml](../.github/workflows/ci.yml) configures an `Interactive browser journey` job
that runs the same spec on a CI runner. Treat the two kinds of evidence separately: a local run
shows the suite passed on one machine at one commit, and a remote run would show the configured job
passed on a runner. This document records no successful remote run, because none has been inspected.

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

## Part 3: offline authoring experiment

The experiment runner sends three fixed briefs (the corpus) through the bounded authoring pipeline
and records a manifest, per-brief artifacts, a comparison report and route reviews. This part runs it
in **offline** mode, where each brief is answered by a scripted fixture, and then inspects what it
saved. It needs no database, Redis, network access or API key once dependencies are installed
(`pnpm install`): the default plan constructs no provider and writes nothing, and offline mode uses
only scripted responses (0 HTTP attempts). Each invocation writes only inside its own fresh temporary
directory and changes nothing under `apps/`. The paid mode (`--mode openai`) is never used here, and
no paid experiment has been run.

Run the steps in order in one PowerShell session, because they share variables. All of them start
with `exp`, so they never collide with Part 2's variables. Step 1 sets every one to `$null`; each
later step refuses to proceed if the step it depends on did not finish, and the whole walkthrough
stops short of any approval, publication or resume. For the options, outputs and exit codes see
[the experiment runner](../apps/api/docs/interactive-authoring.md#authoring-experiment-runner-phase-141)
and [the inspector](../apps/api/docs/interactive-authoring.md#inspecting-a-saved-experiment-phase-143).

### 1. Print and parse the default plan

With no `--mode`, the runner prints a versioned plan and does nothing else. Parse it and confirm that
it says `executes: false`.

```powershell
# Forget anything left over from an earlier invocation in this session.
$expPlanText = $expPlan = $expPlanExit = $null
$expToken = $expRoot = $expDrafts = $null
$expOut = $expExit = $expDir = $expManifest = $expManifestData = $null
$expConfirmed = $expSnapshot = $expBefore = $expAfter = $null
$expInspectOut = $expInspectExit = $expInspection = $expComparison = $null

$expPlanText = pnpm --silent experiment:interactive:authoring
$expPlanExit = $LASTEXITCODE
$expPlanText = @($expPlanText | ForEach-Object { "$_" })
$expPlanText
if ($expPlanExit -ne 0) { throw "Printing the plan failed (exit $expPlanExit); stop." }

$parsed = ($expPlanText -join "`n") | ConvertFrom-Json
if ($parsed.schema -ne 'interactive-authoring-experiment-plan/v1') { throw 'Unexpected plan schema; stop.' }
if ($parsed.executes -isnot [bool] -or $parsed.executes) { throw 'The default plan must report executes:false; stop.' }
if (@($parsed.entries).Count -ne 3) { throw 'Expected a three-brief plan; stop.' }
$expPlan = $parsed
"Plan OK: executes=$($expPlan.executes), briefs=$(@($expPlan.entries | ForEach-Object key) -join ', ')"
```

Expected output, abridged (the plan is about 90 lines of JSON; the hashes identify the briefs and
are the same on every run at a given commit):

```text
{
  "schema": "interactive-authoring-experiment-plan/v1",
  "executes": false,
  ...
  "budget": {
    "briefs": 3,
    ...
    "maxRequests": 6,
    "maxHttpAttempts": 6,
    ...
  },
  ...
}
Plan OK: executes=False, briefs=last-tram, harbour-ledger, clock-blackout
```

The limits are caps, not usage; no cost is estimated.

### 2. Create this invocation's root

Create a new, uniquely named root with an ownership marker that carries a token generated for this
invocation, and a `scenario-drafts` child (the tools require that exact name). The name is kept
short on purpose: the deepest artifact sits 171 characters below the root, and Windows PowerShell
5.1 cannot open a path of 260 characters or more. The step refuses a temporary directory so deep
that the artifacts would not fit.

```powershell
if (-not $expPlan) { throw 'Step 1 did not produce a valid plan; stop.' }

$token = [guid]::NewGuid().ToString('N')
$root = Join-Path ([IO.Path]::GetTempPath()) "storyme-exp-$($token.Substring(0, 16))"
if ($root.Length + 180 -gt 259) { throw "'$root' leaves too little room for the artifacts under Windows PowerShell's 260-character path limit. Set `$env:TMP to a shorter directory (for example C:\Temp) for this session and start again from step 1." }
if (Test-Path -LiteralPath $root) { throw "'$root' already exists; stop." }
$null = [IO.Directory]::CreateDirectory($root)
try {
  Set-Content -LiteralPath (Join-Path $root '.storyme-experiment-owner') -Value "storyme-interactive-experiment $token" -ErrorAction Stop
  $null = [IO.Directory]::CreateDirectory((Join-Path $root 'scenario-drafts'))
} catch {
  # Only the directory created a moment ago, which holds nothing else.
  Remove-Item -LiteralPath $root -Recurse -Force
  throw "Could not initialise the experiment root: $($_.Exception.Message)"
}
$expToken = $token
$expRoot = $root
$expDrafts = Join-Path $root 'scenario-drafts'
"Experiment root: $expRoot"
```

### 3. Run the experiment in offline mode

The mode is stated explicitly; nothing is inferred from the environment.

```powershell
if (-not $expPlan -or -not $expRoot -or -not $expDrafts) { throw 'Steps 1-2 did not finish; stop.' }
if ($expOut) { throw 'The experiment already ran for this root; run the clean-up step and start again from step 1.' }

$expOut = pnpm --silent experiment:interactive:authoring --mode offline --drafts-root $expDrafts
$expExit = $LASTEXITCODE
$expOut = @($expOut | ForEach-Object { "$_" })
$expOut
if ($expExit -ne 0) { throw "The experiment did not complete (exit $expExit); no experiment was selected." }
```

Expected output (the experiment directory differs per run):

```text
Interactive authoring experiment
Mode: offline (scripted fixtures: HARNESS VERIFICATION ONLY, not model performance)
Corpus: interactive-authoring-corpus/v1, 3 briefs; prompt interactive-authoring-prompt/v1; schema interactive-authoring-wire/v1
Budget (maximum): 6 requests, 6 HTTP attempts, 48000 output tokens (caps), 900000 ms; no retries, no concurrency
[1/3] last-tram: REVIEW_REQUIRED (requests 1, HTTP attempts 0)
[2/3] harbour-ledger: REVIEW_REQUIRED (requests 1, HTTP attempts 0)
[3/3] clock-blackout: REVIEW_REQUIRED (requests 1, HTTP attempts 0)
Completeness: COMPLETE (3 completed, 0 stopped, 0 unattempted)
Observed: 3 requests, 0 HTTP attempts
Experiment: <exp root>\scenario-drafts\<timestamp>-authoring-experiment-<hex>--complete
Manifest: <exp root>\scenario-drafts\<timestamp>-authoring-experiment-<hex>--complete\manifest.json
Not approval and not evidence of prose quality: approval templates remain PENDING and nothing is published.
```

`REVIEW_REQUIRED` means the scripted candidate passed the mechanical checks; it is not approval.
Through `pnpm`, any failed script (an incomplete experiment, a usage error) shows as exit `1`; the
step above treats every non-zero status as a stop.

### 4. Select this invocation's experiment

Select the experiment from the `Experiment:` and `Manifest:` lines this run printed. Directory
ordering is never used. The checks then confirm that the printed directory is a `--complete`
experiment directly inside this invocation's drafts folder (and the only entry there), is a real
directory rather than a link, and that its manifest has the identity the plan from step 1 promised:
the same three briefs, with the same scenario ids, versions and brief hashes.

```powershell
if ($null -eq $expExit -or $expExit -ne 0 -or -not $expRoot -or -not $expPlan) { throw 'Step 3 did not complete; no experiment was selected.' }

$dirLines = @($expOut | Where-Object { $_ -like 'Experiment: *' })
$manifestLines = @($expOut | Where-Object { $_ -like 'Manifest: *' })
if ($dirLines.Count -ne 1 -or $manifestLines.Count -ne 1) { throw 'Expected exactly one Experiment: and one Manifest: line.' }
$printedDir = [IO.Path]::GetFullPath($dirLines[0].Substring('Experiment: '.Length).Trim()).TrimEnd('\')
$printedManifest = [IO.Path]::GetFullPath($manifestLines[0].Substring('Manifest: '.Length).Trim())
$leaf = Split-Path -Leaf $printedDir

# Containment: directly inside this invocation's drafts folder, with the expected shape.
if ((Split-Path -Parent $printedDir) -ne [IO.Path]::GetFullPath($expDrafts).TrimEnd('\')) { throw "'$printedDir' is not inside this invocation's drafts folder." }
if ($leaf -notmatch '^\d{8}T\d{6}Z-authoring-experiment-[0-9a-f]+--complete$') { throw "Unexpected experiment directory name '$leaf'." }
if ($printedManifest -ne (Join-Path $printedDir 'manifest.json')) { throw 'The printed manifest is not manifest.json of the printed experiment.' }

# On disk: a real directory and a real file, and nothing else in the fresh drafts folder.
$dirItem = Get-Item -LiteralPath $printedDir -Force -ErrorAction Stop
$manifestItem = Get-Item -LiteralPath $printedManifest -Force -ErrorAction Stop
if (-not $dirItem.PSIsContainer -or $dirItem.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) { throw 'The experiment directory is not a plain directory.' }
if ($manifestItem.PSIsContainer -or $manifestItem.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) { throw 'The manifest is not a plain file.' }
$entries = @(Get-ChildItem -LiteralPath $expDrafts -Force)
if ($entries.Count -ne 1 -or $entries[0].Name -ne $leaf) { throw "Expected only '$leaf' in the fresh drafts folder, found $($entries.Count) entries." }

# Identity: the manifest is the experiment the plan described.
$data = Get-Content -LiteralPath $printedManifest -Raw | ConvertFrom-Json
if ($data.schema -ne 'interactive-authoring-experiment-manifest/v2') { throw "Unexpected manifest schema '$($data.schema)'." }
if ($data.mode -ne 'offline') { throw "Unexpected manifest mode '$($data.mode)'." }
if ($data.configuration.corpusVersion -ne $expPlan.versions.corpus -or $data.configuration.promptVersion -ne $expPlan.versions.prompt -or $data.configuration.wireSchemaVersion -ne $expPlan.versions.wireSchema) { throw 'The manifest versions differ from the plan.' }
$planned = @($expPlan.entries | ForEach-Object { "$($_.key)|$($_.scenarioId)|$($_.version)|$($_.briefHash)" })
$saved = @($data.entries | ForEach-Object { "$($_.key)|$($_.scenarioId)|$($_.version)|$($_.briefHash)" })
if (($planned -join ';') -cne ($saved -join ';')) { throw 'The manifest briefs differ from the plan.' }

$expDir = $printedDir
$expManifest = $printedManifest
$expManifestData = $data
"Selected: $expManifest"
```

### 5. Confirm the final, complete result

```powershell
if (-not $expManifest -or -not $expManifestData) { throw 'Step 4 did not select an experiment; stop.' }
$m = $expManifestData
$checks = [ordered]@{
  'checkpoint FINAL'                    = ($m.checkpoint.state -eq 'FINAL')
  'completeness COMPLETE'               = ($m.completeness.status -eq 'COMPLETE')
  'HARNESS_VERIFICATION_ONLY evidence'  = ($m.evidence.class -eq 'HARNESS_VERIFICATION_ONLY')
  'three briefs completed'              = ($m.completeness.total -eq 3 -and $m.completeness.completed -eq 3 -and @($m.entries | Where-Object { $_.status -eq 'completed' }).Count -eq 3)
  'three requests'                      = ($m.observed.requests -eq 3)
  'zero HTTP attempts'                  = ($m.observed.httpAttempts -eq 0)
  'every approval PENDING'              = (@($m.entries | Where-Object { $_.approval -eq 'PENDING' }).Count -eq 3)
}
$checks.GetEnumerator() | ForEach-Object { '{0,-36} {1}' -f $_.Key, $_.Value }
if ($checks.Values -contains $false) { throw 'The experiment is not the expected final, complete, scripted result; stop.' }
$expConfirmed = $true
```

Expected: every line ends in `True`. The counts say three requests were _recorded_ (one per brief,
each answered by a scripted fixture) and none reached HTTP.

### 6. Snapshot every artifact hash

The snapshot lists every file under the drafts folder with its SHA-256, and every directory, so a
changed, added or removed entry would show. It refuses to proceed if it meets a link.

```powershell
if (-not $expConfirmed) { throw 'Step 5 did not confirm the experiment; stop.' }
$expSnapshot = {
  $base = [IO.Path]::GetFullPath($expDrafts).TrimEnd('\') + '\'
  Get-ChildItem -LiteralPath $expDrafts -Recurse -Force | Sort-Object FullName | ForEach-Object {
    if ($_.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) { throw "Unexpected link: $($_.FullName)" }
    $rel = $_.FullName.Substring($base.Length)
    if ($_.PSIsContainer) { "DIR  $rel" }
    else { "$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash)  $rel" }
  }
}
$expBefore = @(& $expSnapshot)
if ($expBefore.Count -eq 0) { throw 'The snapshot is empty; stop.' }
$expBefore
"Files hashed: $(@($expBefore | Where-Object { $_ -notlike 'DIR *' }).Count)"
```

Expected: 20 files — `manifest.json`, `comparison-report.json`, four artifacts for each of the
three runs under `runs\` and a `.json` and `.md` route review for each brief under `route-reviews\` —
and six directories. The hashes differ from run to run (the artifacts carry timings and a
timestamp), so only compare within one invocation.

### 7. Inspect the saved manifest

The inspector is read-only. It validates the manifest's schema and the artifacts the manifest
references, then prints one JSON document. It is given the absolute manifest path captured in step 4.

```powershell
if (-not $expConfirmed -or -not $expManifest -or -not $expBefore) { throw 'Steps 4-6 did not finish; stop.' }
$expInspectOut = pnpm --silent inspect:interactive:experiment --manifest $expManifest
$expInspectExit = $LASTEXITCODE
$expInspectOut = @($expInspectOut | ForEach-Object { "$_" })
if ($expInspectExit -ne 0) { $expInspectOut; throw "The inspection failed (exit $expInspectExit); stop." }

$i = ($expInspectOut -join "`n") | ConvertFrom-Json
$checks = [ordered]@{
  'status VALID'                   = ($i.status -eq 'VALID')
  'checkpoint FINAL'               = ($i.checkpoint.state -eq 'FINAL')
  'completeness COMPLETE'          = ($i.completeness.status -eq 'COMPLETE')
  'coverage COMPLETE'              = ($i.observed.coverage.status -eq 'COMPLETE' -and $i.observed.coverage.reported -eq 3 -and $i.observed.coverage.unknown -eq 0 -and $i.observed.coverage.notDispatched -eq 0)
  'totals are not a lower bound'   = ($i.observed.totalsAreLowerBound -eq $false)
  'no issues'                      = (@($i.issues).Count -eq 0)
  'run reports compared'           = ($i.artifactChecks.runReportsCompared -eq 3)
  'comparison report present'      = ($i.artifactChecks.comparisonReport -eq 'PRESENT')
}
$checks.GetEnumerator() | ForEach-Object { '{0,-30} {1}' -f $_.Key, $_.Value }
"Observed: $($i.observed.requests) requests, $($i.observed.httpAttempts) HTTP attempts, withinBudget=$($i.observed.withinBudget)"
if ($checks.Values -contains $false) { throw 'The inspection is not valid and complete; stop.' }
$expInspection = $i
```

Expected: every check is `True` and the last line is
`Observed: 3 requests, 0 HTTP attempts, withinBudget=True`. A non-zero exit prints
`{ "status": "INVALID", "issues": [...] }` and never a partial summary. The inspector's own
`evidenceLimits` (in `$expInspectOut`) say what it does not establish: that a valid inspection is not
approval, quality or billing evidence.

### 8. Read the comparison report

The runner wrote `comparison-report.json` from the three run reports. The comparison groups runs
only by identical provider, model, prompt version, schema version and brief hash, so three different
briefs make three separate groups, never one pooled rate.

```powershell
if (-not $expInspection) { throw 'Step 7 did not produce a valid inspection; stop.' }
$cmp = Get-Content -LiteralPath (Join-Path $expDir 'comparison-report.json') -Raw | ConvertFrom-Json
if ($cmp.schema -ne 'interactive-authoring-run-comparison/v1') { throw 'Unexpected comparison schema.' }
$groups = @($cmp.groups)
$planHashes = @($expPlan.entries | ForEach-Object briefHash | Sort-Object) -join ';'
if ($groups.Count -ne 3 -or ((@($groups | ForEach-Object { $_.key.briefHash } | Sort-Object) -join ';') -ne $planHashes)) { throw 'Expected one group per planned brief.' }
$brief = @{}
$expPlan.entries | ForEach-Object { $brief[$_.briefHash] = $_.key }
$rows = $groups | ForEach-Object {
  $tokens = $_.tokenUsage
  if ($null -ne $tokens.input.reportedTotal -or $null -ne $tokens.output.reportedTotal) { throw 'Unexpected reported token usage for a scripted run.' }
  [pscustomobject]@{
    Brief        = $brief[$_.key.briefHash]
    Provider     = $_.key.provider
    Evidence     = $_.evidenceClass
    Samples      = $_.samples
    FirstPass    = "$($_.firstPass.passed)/$($_.firstPass.evaluated)"
    Requests     = $_.providerRequests
    Http         = $_.httpAttempts
    InputTokens  = "null ($($tokens.input.requestsReporting)/$($tokens.input.requestsObserved) reported)"
    OutputTokens = "null ($($tokens.output.requestsReporting)/$($tokens.output.requestsObserved) reported)"
  }
}
$rows | Format-Table -AutoSize
$expComparison = @($rows)
```

Expected: three rows, one per brief (in the report's order, which follows the brief hashes rather than
the corpus order), each with provider `scripted`, evidence `OFFLINE_SCRIPTED`, one sample, first pass
`1/1`, one request, no HTTP attempts, and token totals `null (0/1 reported)`.

How to read it:

- **A first-pass rate of `1/1` is a scripted fixture replaying a known-good answer.** It is not a
  measured model success rate: no model produced these candidates, and one sample per brief has no
  variance. The `OFFLINE_SCRIPTED` label and the manifest's `HARNESS_VERIFICATION_ONLY` class exist
  so that this cannot be quoted as model performance.
- **Token usage is missing, and missing is not zero.** A scripted provider reports none, so each
  total is `null` with a reporting coverage of 0 of 1 requests. No token count and no cost is
  estimated.
- The report's own `limitations` list repeats this: provider labels are not authenticated, durations
  include scripted timing and are not latency benchmarks, and real-model quality remains unverified.

### 9. Confirm inspection changed nothing

```powershell
if (-not $expBefore -or -not $expInspection -or -not $expComparison) { throw 'Steps 6-8 did not finish; stop.' }
$expAfter = @(& $expSnapshot)
$same = ($expBefore.Count -gt 0) -and (($expBefore -join "`n") -ceq ($expAfter -join "`n"))
"Artifacts unchanged: $same ($(@($expAfter | Where-Object { $_ -notlike 'DIR *' }).Count) files hashed)"
if (-not $same) { throw 'The artifacts changed between the snapshots; do not trust this run.' }
```

Expected: `Artifacts unchanged: True (20 files hashed)`. Reading the manifest, running the inspector and
reading the report wrote nothing: hashes, file list and directories are identical to step 6. The
three scenarios (`warsaw-last-tram`, `harbour-night-ledger` and `clock-museum-blackout`) remain
unapproved and unpublished: every approval template under `runs\` is `pending`, and the experiment
has no approval or publication step. "The Last Delivery" is unaffected.

### 10. Clean up

Remove the root only after checking that it is the directory this invocation created: a real
directory (not a link) directly under the temporary directory, named for this invocation's token, and
holding the matching ownership marker. The step also refuses an empty value, the temporary directory
itself, an unrelated directory that merely looks similar, and a tree that contains any link or
junction anywhere inside it.

```powershell
if ([string]::IsNullOrWhiteSpace($expRoot) -or [string]::IsNullOrWhiteSpace($expToken)) { throw 'No experiment root in this session; nothing to remove.' }
if ($expToken -cnotmatch '^[0-9a-f]{32}$') { throw 'The invocation token is malformed; refusing to delete anything.' }
if (-not (Test-Path -LiteralPath $expRoot)) { throw "'$expRoot' does not exist; nothing to remove." }

$tempRoot = (Get-Item -LiteralPath ([IO.Path]::GetTempPath())).FullName.TrimEnd('\')
$target = Get-Item -LiteralPath $expRoot -Force -ErrorAction Stop
$markerPath = Join-Path $target.FullName '.storyme-experiment-owner'
$owned = $target.PSIsContainer -and
  -not $target.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint) -and
  $null -ne $target.Parent -and
  $target.FullName.TrimEnd('\') -ne $tempRoot -and
  $target.Parent.FullName.TrimEnd('\') -eq $tempRoot -and
  $target.Name -ceq "storyme-exp-$($expToken.Substring(0, 16))" -and
  (Test-Path -LiteralPath $markerPath -PathType Leaf) -and
  ((Get-Content -LiteralPath $markerPath -Raw).Trim() -ceq "storyme-interactive-experiment $expToken")
if (-not $owned) { throw "Refusing to delete '$expRoot': it is not this invocation's temporary root." }

# Walk without following links; a single link anywhere inside means this is not the tree we created.
$pending = New-Object System.Collections.Generic.Stack[string]
$pending.Push($target.FullName)
while ($pending.Count -gt 0) {
  foreach ($path in [IO.Directory]::EnumerateFileSystemEntries($pending.Pop())) {
    $attributes = [IO.File]::GetAttributes($path)
    if ($attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing to delete '$expRoot': it contains a link ($path)." }
    if ($attributes -band [IO.FileAttributes]::Directory) { $pending.Push($path) }
  }
}

Remove-Item -LiteralPath $target.FullName -Recurse -Force
if (Test-Path -LiteralPath $target.FullName) { throw "'$($target.FullName)' could not be fully removed." }
"Removed $($target.FullName)"
$expRoot = $expDrafts = $expDir = $expManifest = $expToken = $null
```

This removes only this invocation's root. Starting step 1 again forgets the variables, so run this
step first. A root left by a failed or abandoned invocation stays on disk as
`storyme-exp-<16 hex characters>` under the temporary directory. To remove one, confirm its path and
that it holds your leftover run, set `$expRoot` to the path and `$expToken` to the token on the
line of the `.storyme-experiment-owner` file inside it, then run this step: it still requires the
name and the marker to agree with that token.

### Interrupted experiments

You will not see one in this walkthrough, and the walkthrough does not try to cause one. The runner
replaces `manifest.json` atomically at every step, so a process that is killed leaves its last
checkpoint in an `.incomplete` directory, with the finished briefs, the brief that was awaiting its
response and the briefs never attempted. The checkpoint cannot say whether that request completed or
what it cost, so the entry's usage is `UNKNOWN` (never zero), the observed coverage is `PARTIAL` and
the budget verdict is `null` rather than `true`. The inspector reads such a directory the same way
and, as in step 7, never resumes, retries or repairs anything; a new run always makes a new
directory.

This behaviour is exercised for real by
[experiment-interrupt.spec.ts](../apps/api/scripts/experiment-interrupt.spec.ts): it starts the
runner as a child process, kills it with `SIGKILL` while the second brief awaits its response, and
asserts the checkpoint left on disk and its inspection. The fields and states are described in
[Progress checkpoints and interruption](../apps/api/docs/interactive-authoring.md#authoring-experiment-runner-phase-141).

## What this demonstrates and what it does not

It demonstrates a deterministic, replayable runtime and an authoring workflow whose mechanical gates
and human gate are separate, and an experiment harness that records, checkpoints and re-reads its own
results (Part 3, with scripted fixtures: harness verification, not model performance). It does not
demonstrate real-model authoring (that mode needs `--allow-paid-calls` and has never been run here,
so its quality is unverified), prose quality (mechanical validation cannot judge it), a deployed
service, or generated artwork (the illustrations are local SVG files, and rereading shows the artwork
selected at read time rather than a record of what was shown originally). "The Last Tram" remains
unapproved and unpublished, and rereading applies only to published, completed sessions. The
trade-offs behind those choices are in
[CURRENT_PRODUCT.md](CURRENT_PRODUCT.md#design-trade-offs).
