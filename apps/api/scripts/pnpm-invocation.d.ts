/**
 * Types for the repository's dependency-free `scripts/pnpm-invocation.mjs`, which
 * the API script specs import. The module itself stays plain JavaScript.
 */
declare module '*/pnpm-invocation.mjs' {
  export interface PnpmInvocation {
    command: string;
    args: string[];
    shell: false;
  }

  export interface PnpmInvocationOptions {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    execPath?: string;
    exists?: (path: string) => boolean;
  }

  export function resolvePnpmInvocation(
    args: string[],
    options?: PnpmInvocationOptions,
  ): PnpmInvocation;
}
