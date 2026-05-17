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
 * Returns true if the regex source is potentially catastrophic and must
 * not be compiled/run against untrusted input. Detects:
 *  - star height ≥ 2 — nested unbounded quantifiers, `(a+)+`
 *  - an unbounded-quantified group containing a top-level alternation —
 *    the NFA-ambiguity / overlapping-disjunction class, `(a|a)+`,
 *    `(a|ab)+`, `([a-z]|\w)+`, `(.*|.*)+` (a structural classifier can't
 *    prove branch disjointness, so — conservative by design — any
 *    quantified alternation group is rejected; use `[ab]+` not `(a|b)+`)
 *  - oversized bounded repetitions
 */
export function isUnsafeRegex(source: string): boolean {
  try {
    return analyzeRegexSource(source);
  } catch {
    // The analyzer must never throw into the caller: EventFactory runs
    // this on integrator config during init, *before* (and outside) the
    // `new RegExp(...)` try/catch. Any unexpected internal failure ⇒
    // treat the pattern as unsafe ("when in doubt, reject").
    return true;
  }
}

function analyzeRegexSource(source: string): boolean {
  // Per-group state: does the group's body contain an unbounded-
  // quantified atom/subgroup, and/or a top-level `|` alternation?
  type Frame = { hasUnboundedInside: boolean; hasAlternation: boolean };
  const newFrame = (): Frame => ({
    hasUnboundedInside: false,
    hasAlternation: false,
  });
  const stack: Frame[] = [newFrame()];

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
      stack.push(newFrame());
      continue;
    }

    if (ch === "|") {
      // Top-level alternation within the current group.
      stack[stack.length - 1].hasAlternation = true;
      continue;
    }

    if (ch === ")") {
      // Unmatched ')' (e.g. ")a+", "a)b+"): don't underflow the frame
      // stack — popping the root would leave `stack` empty and later
      // `stack[stack.length-1].x = …` would throw. The pattern is
      // malformed; leave analysis state intact and let `new RegExp(...)`
      // reject it downstream.
      if (stack.length <= 1) continue;

      const group = stack.pop() ?? newFrame();
      const parent = stack[stack.length - 1] ?? newFrame();

      // Look past a quantifier's own modifiers won't matter here; just
      // check the char immediately after ')'.
      const quantified = isUnboundedQuantifierAt(i + 1);

      if (quantified) {
        // Star height ≥ 2: an unbounded-quantified group whose body
        // already contains an unbounded quantifier.
        if (group.hasUnboundedInside) return true;
        // Unbounded-quantified group containing a top-level alternation:
        // the overlapping/ambiguous-disjunction exponential class.
        if (group.hasAlternation) return true;
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
