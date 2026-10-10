/**
 * Editorial approval records for published scenarios, one per (id, version).
 *
 * Each record is a human-authored attestation (see publication/approval.ts)
 * bound to the exact canonical hash of the definition it approves. A scenario
 * added to SCENARIOS without a matching, approved record here (or an entry in
 * the legacy baseline) makes the application refuse to start.
 *
 * Records are added by hand, together with the definition, after the
 * `pnpm preflight:interactive` check passes. Tooling never writes this list.
 * It is intentionally empty: "The Last Tram" has no approval.
 */
export const SCENARIO_APPROVALS: readonly unknown[] = [];
