# claim-audit

**Find the claims on a product page that its own numbers contradict.**

Give it a captured specification page. It inventories the factual claims, recomputes the
page's own unit conversions and specification arithmetic against each other, and prints a
report that states **what it checked** as well as what it found.

It does not decide anything. Every output is a flag for a human to look at, with the
arithmetic shown so the flag can be falsified.

```
node src/audit-run.mjs examples/example-capture.md
```

---

## What it catches

A specification table that lists a material's Young's modulus as **2310 GPa**. No material
is that stiff — diamond is roughly 1050–1200 GPa — so the number cannot be right in the
unit it claims. It is almost certainly **MPa** mislabelled, which is a factor of 1000:

```
1980 GPa = 1980 GPa, which is outside 0.001-1200 GPa
> No material lies outside this range (soft elastomers to diamond (1050-1200 GPa);
  no material exceeds this). The value is most likely stated in a different unit than
  the label says.
```

An engineer reading `2310 GPa` and computing a deflection gets an answer **three orders of
magnitude wrong**. That is the class of error this exists to catch.

**It also checks a page against itself, with no domain knowledge at all.** A page that
states a quantity twice in two unit systems has already committed to a testable
relationship:

```
33 lbs (15.5 kg)      ->  33 lb = 14.9685 kg, but the page states 15.5 kg (3.4% apart)
```

Anything a page states twice, it can be caught contradicting.

---

## What it deliberately does not do

- **It does not fetch pages.** You supply a capture as text. Modern storefronts render
  client-side, and a tool that silently retrieves half a page would report a claim as
  unsupported when the page does support it — the exact failure this is built to avoid.
- **It does not judge.** Every finding is a flag, and every flag carries its own
  arithmetic so you can check it.
- **It refuses an incomplete capture** rather than reporting a clean result. If the
  provenance is missing, or the capture is too short to have contained anything, it stops.
  A report saying "0 findings" is dangerous when the real meaning is "we did not get the
  page".

---

## Design notes worth knowing before you trust it

These are the mistakes that shaped it. They are recorded because each one produced a
wrong answer first.

**A checker that fires on correct work is worse than no checker.** The physical ranges in
`src/claim-arithmetic.mjs` are deliberately generous. A range that is too tight produces
false accusations, and a wrong accusation about someone's published specification is worse
than missing a real defect. Every bound carries a `because` field explaining itself.

**A silently wrong value is worse than a missing one.** Early versions read `ISO 178` as
the number 178, and `±0.02mm` as `2mm`. Both parse without error and look plausible. The
extractor now skips identifier numbers and matches a tolerance sign deliberately, because
the failure mode is not a crash — it is a confident wrong answer.

**A decimal point is not a sentence boundary.** Splitting on `.` cut
`"a tolerance of ±0.1 mm"` into `"a tolerance of ±0."` and `"1 mm"`, which would have
quoted the page as saying something it does not say.

**Abstention is an outcome, not a failure.** Where evidence is ambiguous, the tool reports
that rather than picking a verdict.

---

## Layout

```
src/
  claim-inventory.mjs    capture -> list of factual claims, with offsets
  claim-arithmetic.mjs   physical-range checks, per-property bounds
  claim-conversions.mjs  recomputes a page's own two-unit statements
  spec-layout.mjs        where a value sits on the page, across table layouts
  audit-run.mjs          CLI: capture in, report out
  claim-inventory-run.mjs CLI: capture in, claim inventory out
test/                    64 tests, no network, no fixtures beyond inline strings
examples/                a synthetic capture that triggers both check types
```

**No dependencies.** Node builtins only. `node --test test/*.mjs` runs everything.

---

## Capture format

A markdown file with YAML front-matter. The provenance is required, not optional:

```markdown
---
url: https://example.com/products/sample
fetched: 2026-10-02, 16:30 UTC
captured_by: how the capture was taken
not_captured_in_text:
  - "what did not come through — PDFs, images, widget values"
---

<the page text>
```

**`not_captured_in_text` matters more than it looks.** It travels into the report, because
a claim inside an image or a widget is invisible to this tool, and reporting it as
unsupported when the page does support it would be the wrong answer.

---

## License

MIT. See `LICENSE`.
