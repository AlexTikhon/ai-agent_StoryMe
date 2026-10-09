import { MAX_DIAGNOSTICS, MAX_DIAGNOSTIC_MESSAGE_CHARS } from './limits';

/** Pipeline stages in execution order; a failing stage stops every later one. */
export type ValidationStage =
  | 'candidate-format'
  | 'identity'
  | 'definition'
  | 'authoring-constraints'
  | 'play-analysis'
  | 'witness-routes';

export const VALIDATION_STAGES: readonly ValidationStage[] = [
  'candidate-format',
  'identity',
  'definition',
  'authoring-constraints',
  'play-analysis',
  'witness-routes',
];

export interface Diagnostic {
  stage: ValidationStage;
  /** Stable machine code; the message is for humans and may change. */
  code: string;
  message: string;
}

export interface BoundedDiagnostics {
  diagnostics: Diagnostic[];
  /** How many further diagnostics were dropped to stay within the bound. */
  dropped: number;
}

function clip(text: string): string {
  // Collapse control characters so a diagnostic can never smuggle formatting into logs/reports.
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return flat.length > MAX_DIAGNOSTIC_MESSAGE_CHARS
    ? `${flat.slice(0, MAX_DIAGNOSTIC_MESSAGE_CHARS - 1)}…`
    : flat;
}

/** De-duplicates and bounds both the number and the length of diagnostics. */
export function boundDiagnostics(all: readonly Diagnostic[]): BoundedDiagnostics {
  const seen = new Set<string>();
  const unique: Diagnostic[] = [];
  for (const d of all) {
    const message = clip(d.message);
    const key = `${d.stage}\u0000${d.code}\u0000${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ stage: d.stage, code: d.code, message });
  }
  return {
    diagnostics: unique.slice(0, MAX_DIAGNOSTICS),
    dropped: Math.max(0, unique.length - MAX_DIAGNOSTICS),
  };
}

export function diagnostic(stage: ValidationStage, code: string, message: string): Diagnostic {
  return { stage, code, message };
}
