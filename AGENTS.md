# Pocket for Vikunja

A mobile web app for tasks and checklists in Vikunja. Vikunja serves it through a plugin (`pocket/main.go`).
Read `docs/development.md` for the layout, how to run it locally and how to run the tests. Check any change to how
Pocket looks or responds to touch against `docs/design-rules.md`.

## The code

- The app lives in `src/` (plain CSS and Alpine.js). `npm run build` turns it into `pocket/app/index.html`. Edit
  `src/`, never `pocket/app/index.html`, and commit both: CI checks they match. `docs/development.md` says where
  things are in `src/` and how the Alpine component is assembled from `src/js/app/`.
- `pocket/app/sw.js` is the service worker that lets Pocket open offline. A new file in `pocket/app/` needs a caching
  decision there.
- `pocket/main.go` runs inside Vikunja with Yaegi, from source. It changes no Vikunja data except what its header
  comment says.
- Content from Vikunja (descriptions, comments) goes through `sanitize` before it is shown. Pocket shares Vikunja's
  origin and sign-in, so a script in a description would run as the user.
- Prettier formats the code (`npm run format`), and `npm run lint` checks it. Match the surrounding code's naming and
  comment density.

## Checking a change

- `npm run lint`, `npm run test:unit` and `npm run test:parse` need no server and take seconds. Run them after each
  change.
- `npm run test:local` starts a local Vikunja in Docker and runs every test, which takes minutes. Run it once a piece
  of work is finished, before it is checked on a phone or merged into `main`. Keep commits small, so a failure it
  finds can be traced to one of them.
- A change in behaviour comes with a test, in the test file for that area. Prefer a unit test, which finds the
  problem in seconds.

## Writing

Hints, docs, comments and commit messages all pass one test: a competent stranger reads the sentence once and knows
what it means. If they would ask "what does this mean?", rewrite it or cut it.

- Use the ordinary word: drag, gesture, string, render, spacing, index. Never a house phrase ("the room after the last
  task", "what a finger does"), and never a word the app already uses for something else.
- Say who does what to what. "Moving a task in Pocket also moves it in the web app", not "a move shows on the web".
- One idea per sentence, with a subject and a verb. Join clauses with a full stop, not a colon or a semicolon.
- "It" means the noun just before it. Otherwise repeat the noun.
- A hint is an instruction: verb first, one action per sentence, nothing the screen already shows. Keys and controls
  are pressed or tapped: "Press Enter to move to the first step." Examples use a role, `@user` or `+project`, never
  an invented person. A label says what is there or why it changes: "Added today, no date" beats "No date yet".
- A comment says why, in one or two sentences: the purpose first, then the trap. Cut a comment that narrates what the
  code plainly does. A file's header comment is one short paragraph.
- Don't cite plans or rounds ("inline-add-box-plan, part 1"). Keep the reason, drop the pointer.
- When two versions pass the test, keep the shorter.
- Commits follow conventional commits: `feat(checklists): let a step pick which step it counts from`. The subject is
  under 72 characters and the explanation goes in the body. Types: `feat`, `fix`, `refactor`, `test`, `docs`,
  `chore`, `build`. Work happens on `dev`, merged into `main` by pull request. A release is a GitHub release with a
  tag like `v0.1.0`.
- `docs/development.md` is a map: where things are, the rules that hold across files, and what has tripped people up.
  What a function or a file does is a comment where it is. `npm run lint` fails when the file passes its size limit.
- Discuss a change to the UI before building it. A plan for a feature lives in `docs/design/` while it is being built
  and is deleted once it is built. From then on the code and its comments carry the reasons.

Before and after:

| Before | After |
|---|---|
| Hold a step, then move it up or down, to move it; swipe it left to delete it. | Hold to reorder. Swipe left to delete. |
| the room the web app leaves after the last task | the gap Vikunja's web app leaves after the last task |
| Where each is shown is lines.js's. | lines.js decides where each is shown. |
| Held, it lifts where it is, and the dates draw in as chips around the finger. | Holding a row lifts it, and four date chips appear around the finger. |
| Move `places` off any position already in `taken`. | Make sure no new task gets a position another task already has. |
