# Pocket for Vikunja

A mobile web app for tasks and checklists in Vikunja, served by Vikunja itself through a plugin (`pocket/main.go`).
Read `docs/development.md` for the layout, running it locally and the tests, and `docs/roadmap.md` before changing how
the code is organised.

## The code

- The app is written in `src/` (plain CSS, and Alpine.js), and `npm run build` makes `pocket/app/index.html` from it.
  Edit `src/`, never `pocket/app/index.html`, and commit both: CI checks they match. `docs/development.md` says
  where things are in `src/`, and how the Alpine component is put together from `src/js/app/`.
- `pocket/app/sw.js` lets Pocket open offline. A new file in `pocket/app/` needs thinking about how it's cached there.
- `pocket/main.go` runs inside Vikunja with Yaegi, from source. It changes no Vikunja data except what its header
  comment says.
- Content from Vikunja (descriptions, comments) goes through `sanitize` before it's shown: Pocket shares Vikunja's
  origin and sign-in.
- Match the surrounding code: its compact style, and comments that say why in plain words.

## Checking a change

- `npm run lint` and `npm run test:parse` need no server and take seconds.
- `npm run test:local` starts a local Vikunja in Docker and runs every test. Run it before saying a change works.
- A change to what the app does comes with a test for it, in the test file for that area.

## Writing

- UI labels, docs and commit messages are plain sentences that state the rule, not short jargon.
- Commits follow conventional commits: `feat(checklists): let a step whose step to count from is gone pick the start`.
  Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `build`. Work happens on `dev`, merged into `main` by
  pull request; a release is a GitHub release with a tag like `v0.1.0` (see `docs/roadmap.md`).
- Discuss a change to the UI before building it. Plans for features go in `docs/design/`.
