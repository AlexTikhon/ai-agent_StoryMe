# AI Code Reviewer

A CLI tool for automated GitHub Pull Request review and local `git diff` review powered by an LLM.

The project fetches PR data from the GitHub API, runs changed files through a LangGraph-based review pipeline, and produces a concise summary plus structured findings for meaningful engineering issues in the diff.

## What It Does

- Fetches Pull Request metadata
- Fetches all changed PR files with pagination
- Reviews local working tree changes without creating a PR
- Classifies files by type
- Supports `.ai-reviewer-ignore` patterns for skipping user-selected paths
- Filters out files that are not suitable for review
- Analyzes diffs with an LLM using structured output
- Streams progress and findings to the CLI while the graph is running
- Returns a summary and a list of findings with severity, category, confidence, and line hints

## Pipeline

The graph is defined in [src/graph/reviewer.graph.ts](c:/ForMe/Learning/ai-code-reviewer/src/graph/reviewer.graph.ts) and consists of four steps:

1. `fetchPR`
   Fetches PR metadata and the full list of changed files from GitHub.
2. `filterFiles`
   Classifies files, selects reviewable patch-based files, and records skipped files with explicit reasons.
3. `analyze`
   Sends each selected file to the LLM and collects structured findings. Failures are handled per file, so one bad response does not fail the entire run.
4. `finalize`
   Builds the final summary, including findings counts and skipped file counts.

## Project Structure

- [src/cli.ts](c:/ForMe/Learning/ai-code-reviewer/src/cli.ts) - thin entry point
- [src/cli/](c:/ForMe/Learning/ai-code-reviewer/src/cli) - argument parsing, console styling, output formatting, and review runner
- [src/review/](c:/ForMe/Learning/ai-code-reviewer/src/review) - review domain types, ignore rules, file classification, and patch helpers
- [src/review-sources/](c:/ForMe/Learning/ai-code-reviewer/src/review-sources) - GitHub and local diff adapters that produce review input files
- [src/graph/](c:/ForMe/Learning/ai-code-reviewer/src/graph) - LangGraph state and orchestration nodes
- [src/prompts/review.ts](c:/ForMe/Learning/ai-code-reviewer/src/prompts/review.ts) - review prompt construction
- [src/schemas/review.schema.ts](c:/ForMe/Learning/ai-code-reviewer/src/schemas/review.schema.ts) - structured output schema

## Requirements

- Node.js 20+
- `GITHUB_TOKEN` for GitHub API access
- `OPENAI_API_KEY` for model access

## Installation

```bash
npm install
```

## Environment Variables

Create a `.env` file or export these variables:

```env
GITHUB_TOKEN=your_github_token
OPENAI_API_KEY=your_openai_api_key
```

## Ignore Rules

Create a `.ai-reviewer-ignore` file in the repository root to skip files from review.

- Empty lines and lines starting with `#` are ignored
- `*`, `**`, and `?` glob patterns are supported
- A trailing `/` matches a directory
- `!pattern` re-includes files matched by an earlier ignore rule

Example:

```text
dist/
coverage/
**/*.snap
!src/critical-test.snap
```

## Usage

PR review:

```bash
npm run review -- <owner> <repo> <pullNumber>
```

Example:

```bash
npm run review -- vercel next.js 12345
```

Local diff review against `HEAD`:

```bash
npm run review -- --local
```

Local diff review against a base branch or ref:

```bash
npm run review -- --local --base main
```

Local diff review for a different repository path:

```bash
npm run review -- --local --repo c:\path\to\repo
```

You can combine both:

```bash
npm run review -- --local --base main --repo c:\path\to\repo
```

While the review is running, the CLI prints progress lines such as:

```text
[review] Starting local diff review against HEAD...
[fetch] Collecting local git diff...
[fetch] Found 6 changed local file(s).
[analyze] Reviewing 4 file(s); skipped 2.
[analyze] (1/4) src/cli.ts
[finding] #1 src/cli.ts Conflicting local flags are not rejected explicitly (low, maintainability, confidence=medium)
```

## Example CLI Output

```text
=== SUMMARY ===

Review completed. Findings: high=1, medium=1, low=0. Skipped files: 2.

- src/api/user.ts: The new null handling branch still dereferences profile.id before checking whether profile exists.
- src/config/app.config.ts: Configuration parsing is mostly safe, but missing validation for REVIEW_TIMEOUT_MS can lead to NaN values at runtime.
- package-lock.json: skipped (unsupported_file_type, File classified as lockfile.)
- dist/generated-client.js: skipped (generated_file, Generated artifact or snapshot file.)

=== FINDINGS ===

1. [HIGH] src/api/user.ts
   Null check happens after property access (correctness, confidence=high)
   The patch reads profile.id before guarding against profile being undefined, which can throw at runtime for users without a profile.
   Line hint: @@ -48,7 +48,9 @@
   Suggestion: Move the null/undefined guard before the property access and return early when profile is absent.

2. [MEDIUM] src/config/app.config.ts
   REVIEW_TIMEOUT_MS is parsed without validation (error-handling, confidence=medium)
   Number(process.env.REVIEW_TIMEOUT_MS) can produce NaN, and the current patch does not validate that before using it in timeout logic.
   Line hint: added env parsing block
   Suggestion: Validate the parsed value and fall back to a safe default if it is missing or invalid.
```

Local diff example:

```text
=== SUMMARY ===

Review completed. Findings: high=0, medium=1, low=1. Categories: error-handling=1, maintainability=1. Skipped files: 0. Skipped reasons: none.

- src/graph/nodes/analyze.node.ts: Error handling improved, but the new catch branch loses the original cause in one code path.
- src/cli.ts: Argument parsing is mostly clear, though the local mode branch still allows conflicting flags silently.

=== REVIEW TARGET ===

Local git diff against HEAD

=== FINDINGS ===

1. [MEDIUM] src/graph/nodes/analyze.node.ts
   Wrapped error loses original cause (error-handling, confidence=medium)
   The patch converts an unknown error into a generic message without preserving the original cause, which makes later debugging harder.
   Line hint: catch block in analyzeNode
   Suggestion: Include the original error message or attach it as a cause when building the final error string.

2. [LOW] src/cli.ts
   Conflicting local flags are not rejected explicitly (maintainability, confidence=medium)
   The local CLI path accepts combinations of flags that may be ambiguous to future users and harder to extend safely.
   Line hint: parseArgs local branch
   Suggestion: Validate mutually exclusive flags up front and fail with a clear usage message.
```

## Output Format

The CLI prints:

- `SUMMARY` - the overall review result, including skipped files and per-file notes
- `FINDINGS` - the list of detected issues

Each finding contains:

- `severity`: `high | medium | low`
- `category`: `correctness | security | performance | type-safety | error-handling | maintainability`
- `confidence`: `high | medium | low`
- `title`
- `explanation`
- `lineHint` - a short pointer to the relevant line or diff hunk when available
- `suggestion` - optional remediation guidance
