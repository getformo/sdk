/**
 * Catastrophic-backtracking ("ReDoS") screen for the integrator-supplied
 * `referral.pathPattern` regex.
 *
 * The pattern is applied to `window.location.pathname` (attacker-
 * influenceable via a crafted link) on every analytics event. A length
 * cap does NOT help: an exponential regex like `(a+)+$` or `(x+x+)+y` is
 * tiny, and exponential blow-up happens at a few dozen input chars — so
 * a non-matching path well under any length cap still freezes the main
 * thread on every event.
 *
 * No bullet-proof string test for "evil regex" exists, but the
 * high-impact, real-world class is **star height ≥ 2**: an unbounded
 * quantifier (`*`, `+`, `{n,}`) applied to a subexpression that itself
 * contains an unbounded quantifier — `(a+)+`, `(.*)*`, `((ab)+)+`,
 * `(x+x+)+`. We detect that structurally with a single linear pass, and
 * also reject absurdly large bounded repetitions. Conservative by
 * design: when in doubt, reject (the integrator can use a linear pattern
 * such as `/r/([^/]+)`).
 */

/** Upper bound for an explicit `{n}` / `{n,m}` repetition count. */
const MAX_BOUNDED_REPETITION = 1000;

/**
 * Returns true if the regex source is potentially catastrophic
 * (star height ≥ 2, or an oversized bounded repetition) and must not
 * be compiled/run against untrusted input.
 */
export function isPotentiallyCatastrophicRegex(source: string): boolean {
  // Per-group state: does this group's body contain an unbounded-
  // quantified atom/subgroup? `starred` records, after `)`, whether the
  // just-closed group was itself unbounded-quantified.
  const stack: { hasUnboundedInside: boolean }[] = [
    { hasUnboundedInside: false },
  ];

  const isUnboundedQuantifierAt = (i: number): boolean => {
    const c = source[i];
    if (c === "*" || c === "+") return true;
    if (c === "{") {
      // {n,} (no upper bound) is unbounded; {n} / {n,m} are bounded.
      const close = source.indexOf("}", i);
      if (close === -1) return false;
      const body = source.slice(i + 1, close);
      return /^\d*,\s*$/.test(body) || /^,?\d*,$/.test(body) || /^\d+,$/.test(body);
    }
    return false;
  };

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];

    if (ch === "\\") {
      // `\X` (e.g. \d, \w, \.) is a single atom. Skip the escaped char,
      // then — like any atom — if it is unbounded-quantified, mark the
      // enclosing group (this is what makes `(\d+)*` star-height 2).
      i++;
      if (isUnboundedQuantifierAt(i + 1)) {
        stack[stack.length - 1].hasUnboundedInside = true;
      }
      continue;
    }

    if (ch === "[") {
      // Character class: skip to the matching ] (classes don't nest,
      // but \] is an escaped bracket).
      i++;
      while (i < source.length && source[i] !== "]") {
        if (source[i] === "\\") i++;
        i++;
      }
      // A class is an atom; if unbounded-quantified, mark current group.
      if (isUnboundedQuantifierAt(i + 1)) {
        stack[stack.length - 1].hasUnboundedInside = true;
      }
      continue;
    }

    if (ch === "(") {
      stack.push({ hasUnboundedInside: false });
      continue;
    }

    if (ch === ")") {
      const group = stack.pop() ?? { hasUnboundedInside: false };
      const parent = stack[stack.length - 1] ?? { hasUnboundedInside: false };

      // Look past a quantifier's own modifiers won't matter here; just
      // check the char immediately after ')'.
      const quantified = isUnboundedQuantifierAt(i + 1);

      if (quantified) {
        // Star height ≥ 2: an unbounded-quantified group whose body
        // already contains an unbounded quantifier.
        if (group.hasUnboundedInside) return true;
        // This group is itself an unbounded-quantified atom → its
        // parent now "contains an unbounded quantifier".
        parent.hasUnboundedInside = true;
      }
      continue;
    }

    if (ch === "{") {
      const close = source.indexOf("}", i);
      if (close !== -1) {
        const body = source.slice(i + 1, close);
        const nums = body.match(/\d+/g);
        if (nums && nums.some((n) => Number(n) > MAX_BOUNDED_REPETITION)) {
          return true;
        }
      }
    }

    // A bare atom (literal / dot / class handled above) that is
    // unbounded-quantified marks the enclosing group.
    if ((ch === "." || /[^*+?{}()|\\[\]]/.test(ch)) && isUnboundedQuantifierAt(i + 1)) {
      stack[stack.length - 1].hasUnboundedInside = true;
    }
  }

  return false;
}
