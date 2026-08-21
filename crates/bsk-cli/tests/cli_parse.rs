//! Smoke tests for clap-derive command parsing.

use std::time::Duration;

use bsk::cli::daemon::{DaemonCmd, parse_duration};
use bsk::cli::navigate::NavigateCmd;
use bsk::cli::record::{RecordCmd, RecordSub};
use bsk::cli::session::{SessionCmd, SessionSub};
use bsk::cli::upload::UploadModeArg;
use bsk::{Cli, Command};
use clap::Parser;

fn parse(args: &[&str]) -> Cli {
    Cli::try_parse_from(args).expect("clap parse should succeed")
}

#[test]
fn parses_upload_modes() {
    let cli = parse(&[
        "bsk",
        "upload",
        "@e1",
        "--file",
        "image.png",
        "--session",
        "s1",
    ]);
    let Command::Upload(default_args) = cli.command else {
        panic!("expected upload subcommand");
    };
    assert_eq!(default_args.mode, UploadModeArg::Input);

    let cli = parse(&[
        "bsk",
        "upload",
        "@e1",
        "--file",
        "image.png",
        "--session",
        "s1",
        "--mode",
        "drop",
    ]);
    let Command::Upload(drop_args) = cli.command else {
        panic!("expected upload subcommand");
    };
    assert_eq!(drop_args.mode, UploadModeArg::Drop);

    assert!(
        Cli::try_parse_from([
            "bsk",
            "upload",
            "@e1",
            "--file",
            "image.png",
            "--session",
            "s1",
            "--mode",
            "auto",
        ])
        .is_err()
    );
}

#[test]
fn parses_daemon_start_with_defaults() {
    let cli = parse(&["bsk", "daemon", "start"]);
    let Command::Daemon(DaemonCmd::Start(args)) = cli.command else {
        panic!("expected daemon start subcommand");
    };
    assert!(args.port.is_none());
    assert!(!args.foreground);
    assert_eq!(args.resolved_port(), 52800);
    assert_eq!(args.resolved_daemon_idle(), Duration::from_secs(600));
}

#[test]
fn parses_daemon_start_with_flags() {
    let cli = parse(&[
        "bsk",
        "daemon",
        "start",
        "--foreground",
        "--port",
        "52900",
        "--daemon-idle",
        "2s",
        "--session-idle",
        "30s",
    ]);
    let Command::Daemon(DaemonCmd::Start(args)) = cli.command else {
        panic!("expected daemon start subcommand");
    };
    assert!(args.foreground);
    assert_eq!(args.resolved_port(), 52900);
    assert_eq!(args.resolved_daemon_idle(), Duration::from_secs(2));
    assert_eq!(args.resolved_session_idle(), Duration::from_secs(30));
}

#[test]
fn parses_daemon_stop_and_restart() {
    let cli = parse(&["bsk", "daemon", "stop"]);
    assert!(matches!(cli.command, Command::Daemon(DaemonCmd::Stop)));

    let cli = parse(&["bsk", "daemon", "restart", "--foreground"]);
    let Command::Daemon(DaemonCmd::Restart(args)) = cli.command else {
        panic!("expected daemon restart subcommand");
    };
    assert!(args.foreground);
}

#[test]
fn parses_top_level_status_and_doctor() {
    let cli = parse(&["bsk", "status"]);
    assert!(matches!(cli.command, Command::Status));

    let cli = parse(&["bsk", "doctor"]);
    assert!(matches!(cli.command, Command::Doctor));
}

#[test]
fn parses_console_command_with_context_safety_flags() {
    let cli = parse(&[
        "bsk",
        "console",
        "--session",
        "s1",
        "--tab-id",
        "9",
        "--since",
        "12",
        "--limit",
        "75",
        "--max-text-chars",
        "2048",
        "--include-stack",
    ]);
    let Command::Console(args) = cli.command else {
        panic!("expected console command");
    };
    assert_eq!(args.session, "s1");
    assert_eq!(args.tab_id, Some(9));
    assert_eq!(args.since, Some(12));
    assert_eq!(args.limit, Some(75));
    assert_eq!(args.max_text_chars, Some(2048));
    assert!(args.include_stack);
}

#[test]
fn rejects_zero_console_bounds() {
    assert!(Cli::try_parse_from(["bsk", "console", "--session", "s1", "--limit", "0"]).is_err());
    assert!(
        Cli::try_parse_from(["bsk", "console", "--session", "s1", "--max-text-chars", "0"])
            .is_err()
    );
}

#[test]
fn parses_network_command_with_context_safety_flags() {
    let cli = parse(&[
        "bsk",
        "network",
        "--session",
        "s1",
        "--tab-id",
        "9",
        "--since",
        "12",
        "--limit",
        "75",
        "--max-text-chars",
        "2048",
    ]);
    let Command::Network(args) = cli.command else {
        panic!("expected network command");
    };
    assert_eq!(args.session, "s1");
    assert_eq!(args.tab_id, Some(9));
    assert_eq!(args.since, Some(12));
    assert_eq!(args.limit, Some(75));
    assert_eq!(args.max_text_chars, Some(2048));
}

#[test]
fn rejects_zero_network_bounds() {
    assert!(Cli::try_parse_from(["bsk", "network", "--session", "s1", "--limit", "0"]).is_err());
    assert!(
        Cli::try_parse_from(["bsk", "network", "--session", "s1", "--max-text-chars", "0"])
            .is_err()
    );
}

#[test]
fn parses_install_skill_subcommand() {
    let cli = parse(&["bsk", "install-skill", "--list"]);
    assert!(matches!(cli.command, Command::InstallSkill(_)));
}

#[test]
fn parses_update_subcommand_with_flags() {
    let cli = parse(&["bsk", "update", "--check", "--yes", "--no-restart-daemon"]);
    let Command::Update(args) = cli.command else {
        panic!("expected update subcommand");
    };
    assert!(args.check);
    assert!(args.yes);
    assert!(!args.restart_daemon);
}

#[test]
fn duration_parser_accepts_units() {
    assert_eq!(parse_duration("750ms").unwrap(), Duration::from_millis(750));
    assert_eq!(parse_duration("2m").unwrap(), Duration::from_secs(120));
}

#[test]
fn parses_nested_navigate_back_and_forward() {
    let cli = parse(&["bsk", "navigate", "back", "--session", "s1"]);
    let Command::Navigate(cmd) = cli.command else {
        panic!("expected navigate command");
    };
    assert!(matches!(cmd.command, Some(NavigateCmd::Back(_))));

    let cli = parse(&["bsk", "navigate", "forward", "--session", "s1"]);
    let Command::Navigate(cmd) = cli.command else {
        panic!("expected navigate command");
    };
    assert!(matches!(cmd.command, Some(NavigateCmd::Forward(_))));
}

#[test]
fn parses_click_count_alias() {
    let cli = parse(&["bsk", "click", "@e1", "--session", "s1", "--count", "2"]);
    let Command::Click(args) = cli.command else {
        panic!("expected click command");
    };
    assert_eq!(args.click_count, 2);
}

#[test]
fn parses_hover_with_settle() {
    let cli = parse(&[
        "bsk",
        "hover",
        "@e1",
        "--session",
        "s1",
        "--settle",
        "300ms",
    ]);
    let Command::Hover(args) = cli.command else {
        panic!("expected hover command");
    };
    assert_eq!(args.target.as_deref(), Some("@e1"));
    assert_eq!(args.settle, 300);
}

#[test]
fn rejects_zero_click_count() {
    assert!(
        Cli::try_parse_from(["bsk", "click", "@e1", "--session", "s1", "--count", "0"]).is_err()
    );
}

#[test]
fn parses_upload_with_repeated_files() {
    let cli = parse(&[
        "bsk",
        "upload",
        "@e3",
        "--file",
        "one.png",
        "--file",
        "two.png",
        "--session",
        "s1",
    ]);
    let Command::Upload(args) = cli.command else {
        panic!("expected upload command");
    };
    assert_eq!(args.target.as_deref(), Some("@e3"));
    assert_eq!(args.files.len(), 2);
}

#[test]
fn parses_download_with_exact_output_policy() {
    let cli = parse(&[
        "bsk",
        "download",
        "#export",
        "--out",
        "result.zip",
        "--session",
        "s1",
        "--overwrite",
    ]);
    let Command::Download(args) = cli.command else {
        panic!("expected download command");
    };
    assert_eq!(args.target.as_deref(), Some("#export"));
    assert!(args.overwrite);
}

#[test]
fn parses_record_start_with_browser_and_url() {
    let cli = parse(&[
        "bsk",
        "record",
        "start",
        "--browser",
        "022ca8ac",
        "--url",
        "https://x",
    ]);
    let Command::Record(RecordCmd {
        sub: RecordSub::Start(args),
    }) = cli.command
    else {
        panic!("expected record start subcommand");
    };
    assert_eq!(args.browser.as_deref(), Some("022ca8ac"));
    assert_eq!(args.url.as_deref(), Some("https://x"));
}

#[test]
fn parses_record_start_without_url() {
    let cli = parse(&["bsk", "record", "start", "--browser", "022ca8ac"]);
    let Command::Record(RecordCmd {
        sub: RecordSub::Start(args),
    }) = cli.command
    else {
        panic!("expected record start subcommand");
    };
    assert_eq!(args.browser.as_deref(), Some("022ca8ac"));
    assert!(args.url.is_none());
}

#[test]
fn parses_session_start_with_window_size() {
    use bsk::cli::session::{SessionCmd, SessionSub};
    let cli = parse(&[
        "bsk", "session", "start", "--width", "1280", "--height", "800",
    ]);
    let Command::Session(SessionCmd {
        sub: SessionSub::Start(args),
    }) = cli.command
    else {
        panic!("expected session start subcommand");
    };
    assert_eq!(args.width, Some(1280));
    assert_eq!(args.height, Some(800));
}

#[test]
fn session_start_window_size_defaults_to_none() {
    use bsk::cli::session::{SessionCmd, SessionSub};
    let cli = parse(&["bsk", "session", "start"]);
    let Command::Session(SessionCmd {
        sub: SessionSub::Start(args),
    }) = cli.command
    else {
        panic!("expected session start subcommand");
    };
    assert!(args.width.is_none());
    assert!(args.height.is_none());
}

#[test]
fn rejects_out_of_range_session_start_window_size() {
    assert!(Cli::try_parse_from(["bsk", "session", "start", "--width", "99"]).is_err());
    assert!(Cli::try_parse_from(["bsk", "session", "start", "--height", "7681"]).is_err());
    assert!(Cli::try_parse_from(["bsk", "session", "start", "--width", "abc"]).is_err());
}

#[test]
fn parses_window_resize() {
    use bsk::cli::window::{WindowCmd, WindowSub};
    let cli = parse(&[
        "bsk",
        "window",
        "resize",
        "--session",
        "s1",
        "--width",
        "1280",
        "--height",
        "800",
    ]);
    let Command::Window(WindowCmd {
        sub: WindowSub::Resize(args),
    }) = cli.command
    else {
        panic!("expected window resize subcommand");
    };
    assert_eq!(args.session, "s1");
    assert_eq!(args.width, 1280);
    assert_eq!(args.height, 800);
}

#[test]
fn rejects_invalid_window_resize_dimensions() {
    assert!(
        Cli::try_parse_from([
            "bsk",
            "window",
            "resize",
            "--session",
            "s1",
            "--width",
            "99",
            "--height",
            "800"
        ])
        .is_err()
    );
    assert!(
        Cli::try_parse_from([
            "bsk",
            "window",
            "resize",
            "--session",
            "s1",
            "--width",
            "1280",
            "--height",
            "7681"
        ])
        .is_err()
    );
    // width/height are required for resize.
    assert!(Cli::try_parse_from(["bsk", "window", "resize", "--session", "s1"]).is_err());
}

#[test]
fn parses_emulate_with_device_preset() {
    use bsk::cli::emulate::EmulateArgs;
    let cli = parse(&["bsk", "emulate", "--session", "s1", "--device", "iphone-14"]);
    let Command::Emulate(EmulateArgs {
        session,
        device,
        off,
        ..
    }) = cli.command
    else {
        panic!("expected emulate subcommand");
    };
    assert_eq!(session, "s1");
    assert_eq!(device.as_deref(), Some("iphone-14"));
    assert!(!off);
}

#[test]
fn parses_emulate_manual_overrides() {
    let cli = parse(&[
        "bsk",
        "emulate",
        "--session",
        "s1",
        "--width",
        "390",
        "--height",
        "844",
        "--dpr",
        "3",
        "--mobile",
        "--ua",
        "Mozilla/5.0 (iPhone)",
        "--accept-language",
        "zh-CN",
        "--touch",
        "--max-touch-points",
        "5",
        "--tab-id",
        "7",
    ]);
    let Command::Emulate(args) = cli.command else {
        panic!("expected emulate subcommand");
    };
    assert_eq!(args.width, Some(390));
    assert_eq!(args.height, Some(844));
    assert_eq!(args.dpr, Some(3.0));
    assert!(args.mobile);
    assert_eq!(args.ua.as_deref(), Some("Mozilla/5.0 (iPhone)"));
    assert_eq!(args.accept_language.as_deref(), Some("zh-CN"));
    assert!(args.touch);
    assert_eq!(args.max_touch_points, Some(5));
    assert_eq!(args.tab_id, Some(7));
}

#[test]
fn parses_emulate_off() {
    let cli = parse(&["bsk", "emulate", "--session", "s1", "--off"]);
    let Command::Emulate(args) = cli.command else {
        panic!("expected emulate subcommand");
    };
    assert!(args.off);
}

#[test]
fn parses_emulate_no_mobile_no_touch() {
    let cli = parse(&[
        "bsk",
        "emulate",
        "--session",
        "s1",
        "--device",
        "iphone-14",
        "--no-mobile",
        "--no-touch",
    ]);
    let Command::Emulate(args) = cli.command else {
        panic!("expected emulate subcommand");
    };
    assert!(args.no_mobile);
    assert!(args.no_touch);
    assert!(!args.mobile);
    assert!(!args.touch);
}

#[test]
fn rejects_conflicting_emulate_flags() {
    for extra in [
        &["--mobile", "--no-mobile"][..],
        &["--touch", "--no-touch"][..],
    ] {
        let mut argv = vec!["bsk", "emulate", "--session", "s1", "--device", "iphone-14"];
        argv.extend_from_slice(extra);
        assert!(Cli::try_parse_from(argv).is_err());
    }
}

#[test]
fn rejects_invalid_emulate_values() {
    // Zero / out-of-range dimensions.
    assert!(
        Cli::try_parse_from([
            "bsk",
            "emulate",
            "--session",
            "s1",
            "--width",
            "0",
            "--height",
            "844"
        ])
        .is_err()
    );
    // Non-positive dpr.
    assert!(
        Cli::try_parse_from([
            "bsk",
            "emulate",
            "--session",
            "s1",
            "--width",
            "390",
            "--height",
            "844",
            "--dpr",
            "0"
        ])
        .is_err()
    );
    assert!(
        Cli::try_parse_from([
            "bsk",
            "emulate",
            "--session",
            "s1",
            "--width",
            "390",
            "--height",
            "844",
            "--dpr",
            "abc"
        ])
        .is_err()
    );
    // Zero touch points.
    assert!(
        Cli::try_parse_from([
            "bsk",
            "emulate",
            "--session",
            "s1",
            "--max-touch-points",
            "0"
        ])
        .is_err()
    );
}

#[test]
fn parses_session_start_no_focus() {
    let cli = parse(&["bsk", "session", "start", "--no-focus"]);
    let Command::Session(SessionCmd {
        sub: SessionSub::Start(args),
    }) = cli.command
    else {
        panic!("expected session start subcommand");
    };
    assert!(args.no_focus);
}
