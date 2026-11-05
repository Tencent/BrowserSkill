# macOS CLI signing and notarization

The CLI release uses the same trust boundary as Windows: GitHub builds the
executables, BK-CI signs them internally, and GitHub independently verifies the
returned files before publishing one complete release. Apple credentials and the
Developer ID private key never enter GitHub Actions.

## Release flow

1. Creating a `cli-v<version>` tag triggers `Release CLI` and the two internal
   signing pipelines through the existing GitHub repository integration. No new
   BK-CI API secret is required in GitHub.
2. The Mac pipeline waits for the successful tag build. It checks repository,
   workflow, tag commit reachable from the default branch, run ID, run attempt,
   artifact identity and archive SHA256 before reading the two Mac executables.
3. The internal Mac signs both thin executables with the approved Tencent
   Developer ID Application identity (team `88L2Q4487U`), secure timestamp and
   Hardened Runtime. No extra entitlements are added.
4. A ZIP containing both architectures is submitted using `notarytool`. Only
   `Accepted` is successful. Each executable's CodeDirectory hash must appear in
   Apple's ticket log. Retrying the same build attempt resumes its saved notary
   submission and does not re-sign or resubmit the files. Once the handoff is
   complete, retries revalidate and reuse the exact ZIP and manifest; refreshed
   log timestamps cannot change an already uploaded bundle's identity.
5. Windows creates the GitHub draft. Mac waits for that draft and its Windows
   completion marker, then uploads its signed bundle and completion manifest.
   Both handoffs include the source run and attempt; neither publishes the draft.
6. `Publish CLI` runs Windows and Mac verification separately. The Mac runner
   verifies the Developer ID certificate requirement, team, timestamp, runtime,
   embedded signature, online notarization and original program bytes. Only
   signature metadata, zero padding and required Mach-O header fields may change.
7. Publishing waits for both jobs and downloads their output artifact IDs,
   including a successful job retained from an earlier publishing attempt.
   It checks that all platforms refer to the same
   build and draft, packages the signed bytes into the existing archive names,
   generates `version.json` from the final archives, removes staging assets and
   makes the release public. An unsigned Mac result cannot pass this gate.

The existing `bsk-v<version>-{aarch64,x86_64}-apple-darwin.tar.gz` download format
is unchanged. ZIP is used only for notarization and the internal handoff.
Standalone Mach-O files and ZIPs cannot have tickets stapled to them. Online
notarization checks are therefore required; an offline stapled installer would
need a separate PKG or DMG distribution design.

## Internal pipeline setup

Import `ci/macos-signing.yml` into the same BK-CI project as the Windows pipeline.
Replace its placeholders with:

- The existing Mac signing node, running under the account with access to the
  Developer ID certificate and private key in its keychain.
- The existing GitHub release credential (`AccessToken`, Actions read and
  Contents write for this repository).
- The approved Apple account credential (`username` and app-specific `password`)
  and Apple team credential (`password` field). These are project references,
  never literal values in YAML or source control.
- A fixed reviewed Git commit containing **both** release helper scripts.

Then add the GitHub **Create Branch Or Tag** trigger for `Tencent/BrowserSkill`,
filter `cli-v*`, and publish the configuration. Add the trigger after YAML import:
this BK-CI deployment can drop CREATE events on UI-to-YAML conversion. The helper
also rejects branch events and validates the actual release tag.

The job uses a mutex group to keep concurrent builds from sharing a signing
workspace. Select the actual node in the UI; a display label including an IP
address or status suffix is not its YAML node alias.

The Mac node needs Python 3, curl, codesign, Xcode command-line tools with
notarytool, and network access to GitHub and Apple's notarization services. It
only signs downloaded build inputs; it does not execute code from the tag or
check out that tag on a machine with signing credentials.

## Verification without publishing

Manually supply an existing CLI tag and successful `Release CLI` run ID, and set
`verification_only=true`. This mode still verifies provenance, signs both
architectures, submits to Apple, verifies the result and archives evidence.
It cannot upload to GitHub or change the existing release. It can reuse retained
Mac build artifacts from an already published version.

Inspect `macos-signing.json`, `notary-log.json`, `notary-submission.json` and
`signed-macos.zip` in the BK build artifacts. The log must show `Accepted`, and the
bundle must contain both architectures. Do not infer validity only from a green
plugin status. Local ad-hoc tests exercise content comparison, not Developer ID
trust or notarization.

## Recovery

- Pending notarization: rerun the same BK build with the same source run and
  attempt. Its workspace keeps the signed files and submission ID. Do not clean
  that workspace while Apple is processing it.
- Failed/invalid notarization: inspect Apple's log and fix the cause. Do not
  publish. If submission succeeded but the connection failed before its ID was
  saved, reconcile it with `notarytool history` on the internal node first.
- Source `Release CLI` build rerun: rerun **all** build jobs. Attempt IDs
  deliberately prevent mixing stale source artifacts. Start signing for the new
  source attempt.
- Windows draft unavailable: recover Windows signing first, then retry the Mac
  return step. Only the Windows pipeline owns draft creation.
- GitHub verification timeout: recover internal signing, then use **Re-run failed
  jobs** on `Publish CLI`, or manually dispatch it with the successful source run
  ID. Partial publishing retries use each verification job's artifact ID, so a
  successful platform need not run again. If its verified artifact has expired
  (retained for seven days), rerun all `Publish CLI` jobs to verify both platforms
  again. Published releases are never silently replaced.

Apple references: [notarization overview](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution),
[custom workflows](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow),
and [resolving notarization issues](https://developer.apple.com/documentation/security/resolving-common-notarization-issues).
