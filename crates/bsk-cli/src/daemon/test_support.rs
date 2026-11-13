//! Run lifecycle tests with a fixed BSK_HOME, without mutating the parallel
//! test runner's process environment.

/// Run `test` in a child process that owns a private home.
///
/// `test_name` is the call site's `concat!(module_path!(), "::name")`, which
/// starts with the crate name; libtest registers the test without it, so the
/// first component is dropped here. If that ever stops lining up, the child
/// would match no test and still exit `0`, so the parent now requires the child
/// to report that it ran the test.
pub(super) fn isolated(test_name: &str, test: impl FnOnce()) {
    let test_name = test_name.split_once("::").unwrap().1;
    if std::env::var("BSK_LIFECYCLE_TEST").as_deref() == Ok(test_name) {
        test();
        return;
    }
    let home = tempfile::tempdir().unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", test_name, "--nocapture"])
        .env("BSK_LIFECYCLE_TEST", test_name)
        .env("BSK_HOME", home.path())
        .env("BSK_AUTO_UPDATE", "off")
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "stdout={stdout} stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        passed(&stdout),
        Some(1),
        "the isolated child must run exactly {test_name} in {}\nstdout={stdout}\nstderr={}",
        home.path().display(),
        String::from_utf8_lossy(&output.stderr)
    );
}

/// The `passed` count from libtest's summary line.
fn passed(stdout: &str) -> Option<usize> {
    stdout.lines().find_map(|line| {
        let summary = line.trim().strip_prefix("test result: ")?;
        summary.split_whitespace().nth(1)?.parse().ok()
    })
}

#[cfg(test)]
mod tests {
    use super::passed;

    #[test]
    fn reads_the_passed_count_from_a_libtest_summary() {
        assert_eq!(
            passed("test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 433 filtered out"),
            Some(1)
        );
        assert_eq!(
            passed("running 0 tests\n\ntest result: ok. 0 passed; 0 failed"),
            Some(0)
        );
        assert_eq!(passed("no summary here"), None);
    }
}
