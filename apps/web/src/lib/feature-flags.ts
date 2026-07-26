/**
 * Developer diagnostics are opt-in because this value is compiled into the
 * browser bundle. An unset, misspelled, or differently-cased value fails
 * closed and keeps technical generation details out of the product UI.
 */
export function isDeveloperDiagnosticsEnabled(): boolean {
  return process.env['NEXT_PUBLIC_ENABLE_DEVELOPER_DIAGNOSTICS'] === 'true';
}
