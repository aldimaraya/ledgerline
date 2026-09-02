# Design direction

## The brief, pinned down

One person, one phone, one number. The screen's job: answer *"how am I doing"* in about
five seconds, at night, in bed, one-handed. Then get out of the way.

The thing to design against is the category default. Empower, Mint, and every fintech
dashboard share a look: glossy white cards, a green up-arrow, a pie chart, a gradient
hero, and four CTAs trying to sell you something. That look exists because those products
need you to stay in them. This one doesn't — it's a private instrument you glance at.

## Grounding

The name came out of the architecture doc by accident and turned out to be the design.
A **ledger line** is the short rule that extends the staff when a note sits above or below
it — a line drawn only where a value needs it. That's precisely what this app does, and
it's borrowed from the world you already work in.

## Tokens

### Color

Not black. Deep ink with a green cast, so it reads as instrument panel rather than
terminal.

| Token | Hex | Use |
| --- | --- | --- |
| `--ink` | `#14100D` | Page ground |
| `--ink-raised` | `#1E1B17` | Panels, cards |
| `--rule` | `#332E28` | Hairlines, staff lines |
| `--bone` | `#EDE6DA` | Primary text and the hero figure |
| `--dust` | `#8C8378` | Labels, secondary, timestamps |
| `--brass` | `#D4A24C` | Liquid. The signal color. |
| `--sage` | `#7C9A83` | Retirement |
| `--rust` | `#B4553F` | Liabilities, declines, stale states |

Brass and sage are the only two chromatic values in the interface, and they map to the two
buckets — the palette *is* the information architecture. No color is decorative.

### Type

**DM Mono** — every number, without exception. Tabular by construction, so digits don't
shift as balances update, and mechanical enough to read as a readout rather than a
brochure figure. Set at −0.04em tracking at display sizes.

**Instrument Sans** — labels, navigation, prose. Slightly narrow, quiet, stays out of the
mono's way.

The type does the work that a serif display face usually does here, purely through scale
contrast: 15px eyebrow against a 56px figure, same family, same weight range.

### Layout

Single column, thumb-reachable, no bottom tab bar. The hierarchy is literal — total on
top, its two components beneath it, history below that, detail behind one tap.

```
┌──────────────────────────────┐
│ ledgerline         synced 2h │
│                              │
│ NET WORTH                    │
│ $425,663                     │  ← hero, mono, 56px
│ ▲ $1,240 today               │
├──────────────────────────────┤  ← the staff rule
│ ┌────────────┬─────────────┐ │
│ │ LIQUID     │ RETIREMENT  │ │
│ │ $97,140    │ $328,523    │ │
│ └────────────┴─────────────┘ │
│                              │
│ ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ ← staff  │
│ ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╱╌╌╌         │
│ ╌╌╌╌╌╌╌╌╌╌╌╌╱╌╌╌╌╌╌  ═══     │  ← ledger line
│                              │
│ 1M   6M   1Y   ALL           │
│                              │
│ ACCOUNTS  8 across 4         │
└──────────────────────────────┘
```

### Signature

**The chart is a staff.** Horizontal gridlines are set as five evenly-spaced hairlines.
Where the current value lands, a short brass rule extends *past* the plot into the right
margin, carrying the figure — a note sitting above the staff, needing a ledger line to
hold it.

It's one idea, used once, in the one place the eye lands after the hero number.

### Motion

Exactly one moment: the chart line draws left to right over 500ms on open. Nothing else
animates. No counting-up hero number — you came here to read a figure, not watch it
arrive. `prefers-reduced-motion` skips the draw entirely.

## Plan critique

Two things got revised before building.

**The palette was cream and terracotta on the first pass.** Warm cream ground, high-
contrast serif, clay accent. That's the house style of every AI-generated finance mockup
in circulation, and it isn't grounded in anything about this app. Replaced with the dark
ink ground, which is defensible on use: you check this at night, and a glowing figure on
dark reads faster than dark-on-light at a glance.

**The hero figure was a serif.** Big serif numerals signal *wealth management brochure* —
exactly the register of the product being replaced. Mono is the honest choice: this is a
readout from instruments you own.

## The quality floor

- Staleness shown on every screen. A number without an age is a lie.
- Errors state what broke and the one action that fixes it. No apology, no vague "something
  went wrong."
- Tap targets ≥44px. Visible focus rings. Full contrast on the hero at AA.
- The `illiquid` bucket is styled but never rendered — nothing is tagged that way in v1.
