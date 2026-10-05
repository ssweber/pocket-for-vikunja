# Pocket for Vikunja

A mobile web app for Vikunja, served by Vikunja itself through a plugin (`pocket/main.go`). Read
`docs/development.md` for the layout, running it locally and the tests, and `docs/roadmap.md` before changing how the
code is organised.

## The code

- All of the app is in `pocket/app/index.html`: plain CSS, and Alpine.js. There's no build step yet (the roadmap adds
  one). Edit it in place, in the marked section that fits.
- `pocket/app/sw.js` lets Pocket open offline. A new file in `pocket/app/` needs thinking about how it's cached there.
- `pocket/main.go` runs inside Vikunja with Yaegi, from source. It changes no Vikunja data except what its header
  comment says.
- Content from Vikunja (descriptions, comments) goes through `sanitize` before it's shown: Pocket shares Vikunja's
  origin and sign-in.
- Match the surrounding code: its compact style, and comments that say why in plain words.

## Checking a change

- `npm run test:parse` needs no server and takes seconds.
- `npm run test:local` starts a local Vikunja in Docker and runs every test. Run it before saying a change works.
- A change to what the app does comes with a test for it, in the test file for that area.

## Writing

- UI labels, docs and commit messages are plain sentences that state the rule, not short jargon.
- Commits follow conventional commits: `feat(checklists): let a step whose step to count from is gone pick the start`.
  Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`. Work happens on a branch, merged into `main` by pull
  request.
- Discuss a change to the UI before building it. Plans for features go in `docs/design/`.
