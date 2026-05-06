<!-- Thanks for the contribution! Fill out as much of this as is relevant. -->

## What

<!-- One-sentence summary of the change. -->

## Why

<!-- Bug it fixes, capability it adds, link to issue (Closes #N). -->

## How

<!-- Notable design choices, alternative approaches you ruled out. -->

## Checks (please tick before requesting review)

- [ ] `npm run lint` is clean (0 errors)
- [ ] `npm run format:check` is clean
- [ ] `npm test` is green
- [ ] If touching `nodes/utils/path-validator.js`, `websocket-manager.js`,
      or download flows: I added a test for the security property and read
      `SECURITY.md`.
- [ ] If adding a new public option: I documented it in the node's `.html`
      help and in the README.

## Compatibility

- [ ] No breaking change.
- [ ] Breaking change — described below + migration note for users.

## Notes for the reviewer

<!-- Anything reviewer-specific: places where you'd appreciate scrutiny,
     known follow-ups deferred to a separate PR, etc. -->
