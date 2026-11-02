---
name: ui-review
description: >
  Checks a user-interface change for the things code review misses: every state handled,
  accessibility, layout from phone to desktop, consistency with the project's components
  and tokens, and clear wording. Use on projects with a UI when building, reviewing or
  trying a visible change, or when asked to "check the UI", "polish this screen" or "is
  this accessible". Follows the project's design conventions file when there is one.
---

# UI review

A visible change is done when it looks and behaves like the rest of the product in every
state a user can reach, for every user. This skill lists what to check; the project's
design conventions file, when it exists, wins over anything here.

## 1. Know the house style

- Read the project's design conventions and find its components and design tokens
  (colours, spacing, type, radii, shadows).
- Look at two or three existing screens close to the change. The new work should feel
  like their sibling.

## 2. States

For every element the change adds or touches:

- [ ] Loading, empty, error and success states exist and say something useful.
- [ ] Long text wraps or truncates on purpose; a missing image or value does not break
      the layout; large and tiny numbers fit.
- [ ] Interactive elements show hover, focus, pressed and disabled states.
- [ ] Slow and failed requests leave the user able to retry or go back.

## 3. Accessibility

- [ ] Text contrast is at least 4.5:1, or 3:1 for large text and meaningful icons.
- [ ] Everything works with the keyboard alone, in a sensible order, with a visible
      focus ring.
- [ ] Buttons are buttons and links are links; every input has a label; icon-only
      controls have an accessible name.
- [ ] Headings form an outline; landmarks (main, navigation) are present.
- [ ] Meaningful images have alternative text; decorative ones are hidden from assistive
      tech.
- [ ] Motion is subtle and respects the reduced-motion setting; nothing flashes.

## 4. Layout

- [ ] Works from 360px wide to a large desktop, with no horizontal scrolling.
- [ ] Touch targets are at least 44 by 44 pixels.
- [ ] Spacing and alignment use the project's scale, not one-off values.

## 5. Consistency

- [ ] Existing components are used before new ones; new ones match their neighbours.
- [ ] No hard-coded colour, size or spacing where a token exists.
- [ ] One name per thing across the interface.

## 6. Words

- [ ] Buttons say what they do.
- [ ] Errors say what happened and what to do next, without blame or jargon.
- [ ] Copy is short; the most important word comes first.

## Reporting

As findings, each with where (screen, component, `file:line`), what a user experiences,
and the smallest fix. Group them: must fix (broken state, inaccessible, unusable at some
width), should fix (inconsistent, unclear), suggestion. Attach screenshots when the
finding is visual.

When asked to fix rather than review, make the smallest change that resolves each
finding, using the project's own components and tokens.
