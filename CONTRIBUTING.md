# Contributing

This is a competition prototype. Issues and suggestions are welcome, and the release is frozen until judging ends, so changes may wait.

**Security problems:** follow [SECURITY.md](SECURITY.md), and please don't open a public issue with details.

## Setup
Follow [Run it locally](README.md#run-it-locally). It needs Node 24, and no key or VM.

## Before proposing a change
```
npm run proofops:release
```
That runs the typecheck, tests, smoke missions, evidence checks and secret scan. It needs a clean working tree.

## Rules this project keeps
- **Keep evidence honest.** Never edit a sealed bundle. A result keeps the commit and tier it ran at.
- **Fail closed.** There's no silent fallback to a weaker sandbox or to the scripted planner.
- **No secrets** in code, tests, logs or evidence. The worker never receives a key.
- **Every defect gets a regression test.**
- **Claims follow [proof/FACT-SHEET.md](proof/FACT-SHEET.md).** Don't add claims evidence doesn't support.

Contributions are under the MIT license.
