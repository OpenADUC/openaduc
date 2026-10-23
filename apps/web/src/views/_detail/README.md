# Detail page shared bits

`ObjectPageLayout` is the layout every object page (user, group, computer)
shares: the header (avatar, name and badges, subtitle, identifier line,
launchers and DN copy chip, primary actions), the tab bar with refresh and
the Actions menu, the page body for the active tab, and the freshness line.
Pages mount it while their record loads and keep it mounted once it has,
and pass:

- header data as props, badges in the `badges` slot, the object's state
  in the `status` slot (under the name, folded away in the compact header),
  and primary actions in the `primary` slot (it gets `compact` so a button
  can shrink with the header);
- `tabs` (`ObjectPageTab`: label, icon, count, visibility, icon-only) and a
  `fallbackTab`;
- `actions` (`ObjectAction`): each names the capability it needs, and may be
  `unavailable` for this object, saying why (Unlock on an account that
  isn't locked: "account isn't locked"), or disabled while something runs. The
  layout drops what the operator can't do and hides the Actions button
  when nothing is left. An action with a `shortcut` key runs on that key
  (see `design/composables/useShortcuts.ts`) whenever its menu item could
  be clicked; Enable and Disable share `e`, the one that fits the object
  answering it. The layout also gives the first nine visible tabs the
  keys 1 to 9;
- `actionFailure` (`ActionFailure`, from `design/lib/actionFailure.ts`)
  when an action failed: the layout shows it under the Actions menu, with
  Retry and dismiss, until the page clears it;
- `refreshing`, and handle `@refresh`;
- `loading` while there's no record yet, with placeholder header props
  and without the slots that read the record. The layout then draws a
  skeleton in the header's own elements, shows the tabs with their counts
  held, disables refresh, keeps the Actions button (disabled) if the
  operator holds a capability any action needs, and puts skeleton cards
  in place of the body. `skeleton` (`ObjectPageSkeleton`) says what the
  loaded page usually has (a status line, a subtitle, how many cards), so
  the skeleton takes about the same room. The record then fills the same
  header and tab bar, so nothing above the body moves. The skeleton shows
  only after 150 ms (`skeleton-delayed` in `theme.css`).

The default slot renders the body; it gets `tab` (the active tab) and
`select(id)` to switch tabs from the body.

The header and tab bar are styled only by the layout's own CSS; nothing in
`theme.css` reaches them except the shared `.ds-tab-count` chip.

`useStickyHeader` drives the compact-on-scroll header. The layout binds its
`setHero` to the header `<section>` and toggles `is-compact` from its
`compact` ref; CSS transitions do the rest: padding tightens, the avatar
shrinks, and the secondary rows collapse to zero height. The same element
handles both states, so nothing mounts or unmounts mid-scroll.
`heroHeight` tracks the header's measured height via a `ResizeObserver`;
the layout binds it to `--detail-sticky-offset` so the sticky tab bar
always pins flush with the header's current bottom edge, including
mid-shrink-animation. The Group Policy page uses it on its own.

`useCompactTabs` drives icon-only tab collapse. The layout binds its
`setNav` to the tab `<nav>` and toggles `compact` from its ref. A
`ResizeObserver` on the nav compares `scrollWidth` to `clientWidth` (with
hysteresis) and flips the ref when content would overflow. CSS hides
`.object-tab-label` while the class is set; each tab's `title` attribute
carries the full label so the native browser tooltip identifies icons.

`useRouteTab` keeps the active tab in the `tab` query parameter, so reload,
Back and shared links reopen the same tab. Switching replaces the history
entry instead of pushing one. Pass it the tab list with visibility, a
fallback, and a `ready` flag for when visibility is final (tabs that
depend on the loaded record); unknown or hidden tabs fall back and are
dropped from the URL.

`useUndoableDialog` is a dialog that makes one undoable write: it owns
the workflow and the dialog's open state, toasts the write with Undo,
and places a failed write in the dialog that made it or, for an Undo, as
`pageFailure` for `actionFailure`. `useMoveDialog` (Move to OU on the
user and computer pages, rendered with `MoveToOuDialog`) and
`useExpiryDialog` (a user's account expiry, rendered with
`AccountExpiryDialog`) are built on it.
