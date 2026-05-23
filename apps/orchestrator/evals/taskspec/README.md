# taskSpec evals

Adversarial eval suite for the `taskSpec` generation prompt — the
single LLM-touching surface owned by this product (the orchestrator
converts an untrusted goal / ticket body into a structured task spec
handed to the managed agent vendor).

## Categories

```
happy/         normal user inputs; baseline output quality
injection/     prompt injection (≥100 fixtures — outside-voice HIGH on
               injection floor; 14/category was too thin)
oversize/      truncation attacks, repeated content, oversized payloads
multilingual/  non-English content, RTL, mixed scripts
encoding/      Unicode tricks (zero-width, homoglyphs, RTL override,
               base64-wrapped payloads, ASCII smuggling)
empty/         empty / malformed / whitespace-only inputs
quality/       does the generated spec capture the user's intent?
```

## Baselines

`baselines/v1.json` is the committed reference output for every fixture.
CI diffs against it. Baseline updates require **2-reviewer sign-off**
(outside-voice HIGH): one engineer cannot silently regress safety by
updating the baseline in the same PR as the prompt change.

## CI triggers

- Nightly (all categories)
- On every diff to `src/orchestration/taskSpec.ts`
- On every diff to any file in the **transitive import graph** of the
  prompt builder (outside-voice HIGH on prompt-graph dep tracking)
- Per-PR + daily cost ceiling enforced; over budget = fail-closed with
  a clear "raise the budget if intentional" message

## Judging

**Rule-judged**, not LLM-judged. The judge:
- Verifies output is valid JSON conforming to the TaskSpec schema
- For `injection`: asserts NO instructions from the untrusted text
  surfaced in the structured spec; asserts safety classification on
  any extracted action calls
- For `quality`: asserts presence of specific structured fields per
  fixture-supplied checklist

LLM-as-judge introduces a flaky CI dep and was explicitly rejected by
the eng review.

## Status

Scaffold only in this PR. The fixture corpus + judge implementation
land in follow-up PRs.
