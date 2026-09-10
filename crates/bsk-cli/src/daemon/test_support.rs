//! Run lifecycle tests with a fixed BSK_HOME, without mutating the parallel
//! test runner's process environment.

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
    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
