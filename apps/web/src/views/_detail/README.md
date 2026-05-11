# Detail page shared bits

`useStickyHeader` is the composable that drives the compact-on-scroll
header behavior shared by `UserDetailView`, `GroupDetailView`, and
`ComputerDetailView`.

Each page binds the composable's `setHero` function to the hero
`<section>`'s `:ref`, and toggles an `is-compact` class on the same
section based on the composable's `compact` ref. CSS transitions on
the hero do the rest: padding tightens, the avatar/mark shrinks, and
secondary rows (subtitle, identifier line, launchers, DN, description)
collapse to zero height. The same hero element handles both states —
nothing mounts or unmounts mid-scroll.

The composable also exposes `heroHeight`, a reactive number tracking
the hero's measured height via a `ResizeObserver`. Pages with a
sticky child below the hero (the User page's tab bar, the Group page's
Members card head) bind it to `--detail-sticky-offset` on the
page-inner so those children always pin flush with the hero's current
bottom edge — including mid-shrink-animation.

`useCompactTabs` is the composable that drives icon-only tab collapse on
`UserDetailView`. The page binds the composable's `setNav` function to
the tab `<nav>`'s `:ref` and toggles a `compact` class on the same nav
based on the composable's `compact` ref. A `ResizeObserver` on the nav
compares `scrollWidth` to `clientWidth` (with hysteresis) and flips the
ref when content would overflow. CSS hides `.ds-tab-label` while the
class is set; each tab's `title` attribute carries the full label so the
native browser tooltip identifies icons.
