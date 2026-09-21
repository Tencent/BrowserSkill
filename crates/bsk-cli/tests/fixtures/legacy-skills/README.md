# Frozen legacy migration fixtures

`root.md` and `crate.md` are byte-for-byte snapshots of `skill/SKILL.md` and
`crates/bsk-cli/skill/SKILL.md` from commit
`5f48564bbcea92511bd011fe31859840fd6489b7`, before skill packages were split.

These are immutable regression inputs, not skill sources. Do not update them when
authored skills change. Tests pin their hashes and generate CRLF variants from the
LF snapshots. `.gitattributes` keeps these fixtures at LF on every checkout.
