/**
 * A counter that the scheduler bumps after every tick. Page data is cached
 * against it, so a render repeats the database work only after new checks
 * have been written. Lives on globalThis to survive dev hot reloads.
 */
const globals = globalThis as { __statusDataVersion?: number };

export function getDataVersion(): number {
  return globals.__statusDataVersion ?? 0;
}

export function bumpDataVersion(): void {
  globals.__statusDataVersion = getDataVersion() + 1;
}
