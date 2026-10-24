// The test list: off production, a send the business starts (an event's message, a nudge, a held
// send when it comes due) goes only to addresses on it, so a staging copy of real data never
// reaches a real customer. Replies to people who wrote first are never checked here.
//
// - FLOW_ENVIRONMENT=production: no list, everyone.
// - Otherwise: the numbers in `variable` (default FLOW_TEST_NUMBERS; comma-separated E.164, spaces
//   fine, anything else ignored), or `numbers`; none sends nothing (fail closed).
// - `testing` adds the addresses `madeUp` matches (a test run's made-up numbers).

const E164 = /^\+\d{8,15}$/;

export interface EventTestList {
  /** Whether a business-started send may go to this address. */
  allows(address: string): boolean;
  /** Whether a list applies at all (false on production). */
  enforced: boolean;
}

/** The numbers in a comma-separated list: spaces dropped, anything not E.164 left out. */
export function parseTestNumbers(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((n) => n.replace(/\s+/g, ""))
    .filter((n) => E164.test(n));
}

export function eventTestList(options: { env?: Record<string, string | undefined>; variable?: string; numbers?: string[]; testing?: boolean; madeUp?: RegExp } = {}): EventTestList {
  const env = options.env ?? process.env;
  if (env.FLOW_ENVIRONMENT === "production") return { enforced: false, allows: () => true };
  const listed = new Set(options.numbers ? parseTestNumbers(options.numbers.join(",")) : parseTestNumbers(env[options.variable ?? "FLOW_TEST_NUMBERS"]));
  const madeUp = options.madeUp;
  return { enforced: true, allows: (address) => listed.has(address) || (options.testing === true && madeUp !== undefined && madeUp.test(address)) };
}
