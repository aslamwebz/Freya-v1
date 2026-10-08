# Test strategy

Freya has accumulated thousands of tests across many completed phases. They remain valuable, but they are not all part of the inner development loop.

## Active Chat development

- npm test / npm run test:chat: fast current App Mode + Chat unit coverage.
- npm run test:chat:integration: Chat plus Browser, Eye/research, capability/provider routing, relevant Mind/Cognition and host boundaries.
- npm run test:browser-dock: real Electron smoke for the current docked browser.

Use these while Chat is still being built.

## Milestone regression

- npm run test:regression: renderer/unit + Core + host suites. Use before a significant merge when changes cross broad Core seams.
- npm run test:full: every Vitest suite, including historical red-team, qualification and self-skipping live suites. Use for major milestones and release verification, not every edit.

## Release-only / historical coverage

- npm run test:redteam: adversarial gauntlet.
- npm run test:qualification and npm run qualify: release qualification.
- npm run test:e2e: historical desktop E2E until the old shells are retired. It is not evidence that current App Mode Chat is visually correct.

CI calls test:full explicitly. Changing the developer default therefore does not reduce release coverage.
