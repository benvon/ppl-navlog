/** Test-only fixture helpers; never imported by production worker code. */
export const fixtureClock = (initial: number) => { let current = initial; return { now: () => current, set: (value: number) => { current = value; } }; };
