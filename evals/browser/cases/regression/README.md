# Regression cases

Each user-reported badcase should live in its own directory with a manifest, synthetic fixture, and
README describing the symptom, minimal reproduction, expected behavior, source reference, and fix.
Never commit credentials, cookies, HAR files, production HTML, private screenshots, or proprietary
assets.

Create a starting point with:

```sh
pnpm eval:browser scaffold <case-id> --title "..." --source "issue-or-pr"
```
