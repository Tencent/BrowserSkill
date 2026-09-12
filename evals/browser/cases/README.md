# Browser evaluation cases

Cases are discovered recursively from `*.case.json`; colocated `*.fixture.mjs` files are discovered
as fixtures. Use `core` for small deterministic acceptance checks, `matrix` for seeded variations,
and `regression/<case-id>/` for privacy-safe minimized user badcases.

Run `pnpm eval:browser validate` after every case change. See the parent
[`README.md`](../README.md) for the manifest contract, workflow actions, scaffolding, and acceptance
criteria.
