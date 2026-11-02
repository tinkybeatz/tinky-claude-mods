# Design conventions

How the interface of {{projectName}} looks and behaves, so every change feels like the
same product. Only for projects with a user interface.

## Building blocks

- Use the project's own components and design tokens (colours, spacing, type sizes,
  radii, shadows) before anything new. Their home: `<path>`.
- No hard-coded colour, size or spacing value where a token exists.
- A new component is added only when no existing one fits, and it follows the same API
  style as its neighbours.

## States

Every screen and component a change touches handles each state that can happen:

- loading, empty, error, and success;
- long text, missing images, very small and very large numbers;
- disabled, focused, hovered and pressed, for anything a user can act on.

## Accessibility

- Text contrast at least 4.5:1 (3:1 for large text and icons that carry meaning).
- Every action works with the keyboard alone, in a sensible order, with a visible focus.
- Interactive elements are real buttons, links and inputs, with labels a screen reader
  reads out.
- Images that carry meaning have alternative text; decorative ones are hidden from
  assistive tech.
- Motion respects the system's reduced-motion setting.

## Layout

- The layout works from a narrow phone (360px) to a wide desktop without horizontal
  scrolling.
- Touch targets are at least 44 by 44 pixels.

## Words

- Buttons say what they do ("Save invoice", not "OK").
- Error messages say what happened and what to do next, in the user's words, without
  blame.
- One name per thing across the whole interface (see the glossary when there is one).

## Checking a change

- QA tries each state above that the change can reach, on a narrow and a wide screen,
  and with the keyboard.
- Screenshots of before and after go in the PR body for any visible change.
