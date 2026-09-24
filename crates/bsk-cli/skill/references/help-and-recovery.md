## Human steps and recovery

With help enabled, request help for login, CAPTCHA, OTP, payment confirmation,
consent, or after two attempts make no progress:

```sh
bsk request-help --session <id> --prompt "Please complete sign-in" --target @e3
```

Use a precise prompt and fresh targets; omit `--target` when no control fits.
Use completion criteria only for a clear, stable success signal. `all` and `any`
support at most eight conditions in total. For URL completion, `url_matches`
accepts RE2-compatible regular expressions of at most 128 characters. A compiled
pattern may contain at most 4096 instructions, and all distinct patterns together
at most 8192. Invalid or over-budget patterns return `invalid_params` before help
starts. URL conditions do not auto-complete on URLs longer than 8192 characters;
the user can still finish the help request manually. Empty, null, and omitted
`url_matches` values impose no URL-regex condition.

RE2 rejects JavaScript patterns such as `\u0061`, `a{1001}`, `[^]`, lookahead,
lookbehind, and backreferences. Some accepted patterns differ in meaning: `\a`
is a control character in RE2 rather than `a`, and RE2's `\s` does not include
Unicode whitespace. Rewrite patterns in RE2 syntax; use `url_contains` when a
substring is enough.

| Result | Next step |
| --- | --- |
| Help `continued` / `completed` | Observe again, then resume with fresh refs. |
| Help `cancelled` / `timed_out` | Respect rejection or the blocker; do not repeat the request. |
| Help `disabled` | No human action was confirmed. Re-observe and follow the disabled-help rules below. |
| Stale ref | Observe and retry the intended action once. |
| Unknown tab/session | List current tabs/sessions; never guess IDs or use another task's session. |
| Timeout or unknown effect | Inspect current state before retrying; the action may already have happened. |
| `fill_value_mismatch` | Read the field: formatting may still satisfy the request. Correct only a remaining difference; no blind refill or immediate handoff. |
| Unsupported operation | Use available capabilities; suggest updating only if the missing feature is needed. |

Navigation alone (including deprecated help outcome `navigated`) is not completion.
For other errors, follow the returned hint and inspect the current state.

**Help disabled:** do not request help or re-enable it. Use existing login state,
authorized inputs and viable alternatives; disabling help adds no permission and
does not remove borrow confirmation or host restrictions. Where authorized, a
vision-capable model may attempt graphical verification. Phone-only QR scans,
face verification, missing SMS codes or image-only tasks for a text-only model
may remain blocked. Report a specific blocker only when inputs/capabilities are
missing or viable approaches are exhausted; continue independent work. Do not loop
on identical failures, repeat unknown effects or switch backends to bypass limits.
On an unrecoverable failure, report the blocker and stop the owned session.
