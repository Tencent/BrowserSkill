use std::process::ExitCode;

use clap::{Parser, error::ErrorKind};

use bsk::cli::error::{CliError, Format, render};
use bsk::cli::status::Output;
use bsk::{Cli, Command, cli};

fn main() -> ExitCode {
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(err) => {
            let exit = match err.kind() {
                ErrorKind::DisplayHelp | ErrorKind::DisplayVersion => 0,
                _ => 1,
            };
            let _ = err.print();
            return ExitCode::from(exit);
        }
    };

    // The daemon installs its own subscriber (with the rolling file
    // appender); CLI tracing would race with it and silently win, so
    // only init the CLI-side stderr subscriber for client commands.
    if !matches!(cli.command, Command::Daemon(_)) {
        init_cli_tracing(&cli.flags);
    }

    let format = if cli.flags.json {
        Format::Json
    } else {
        Format::Human
    };

    match dispatch(cli, format) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => render(&err, format),
    }
}

fn dispatch(cli: Cli, format: Format) -> Result<(), CliError> {
    match cli.command {
        Command::Daemon(cmd) => cli::daemon::dispatch(cmd).map_err(CliError::Local),
        Command::Status => {
            let output = if cli.flags.json {
                Output::Json
            } else {
                Output::Human
            };
            cli::status::run(output).map(|_| ())
        }
        Command::Doctor => {
            let output = if cli.flags.json {
                Output::Json
            } else {
                Output::Human
            };
            cli::doctor::run(output)
                .map(|_| ())
                .map_err(CliError::Local)
        }
        Command::InstallSkill(args) => {
            let output = if cli.flags.json {
                Output::Json
            } else {
                Output::Human
            };
            cli::install_skill::dispatch(args, output)
        }
        Command::Logs(cmd) => cli::logs::run(cli::logs::LogsArgs {
            follow: cmd.follow,
            lines: cmd.lines,
        })
        .map_err(CliError::Local),
        Command::Session(cmd) => cli::session::dispatch(cmd, format),
        Command::Browsers => cli::browsers::dispatch(format),
        Command::Tab(cmd) => cli::tab::dispatch(cmd, format),
        Command::Screenshot(args) => cli::screenshot::dispatch(args, format),
        Command::Snapshot(args) => cli::snapshot::dispatch(args, format),
        Command::Console(args) => cli::console::dispatch(args, format),
        Command::GetHtml(args) => cli::get_html::dispatch(args, format),
        Command::Navigate(args) => cli::navigate::dispatch_navigate_command(args, format),
        Command::NavigateBack(args) => cli::navigate::dispatch_navigate_back(args, format),
        Command::NavigateForward(args) => cli::navigate::dispatch_navigate_forward(args, format),
        Command::Reload(args) => cli::navigate::dispatch_reload(args, format),
        Command::Click(args) => cli::interaction::dispatch_click(args, format),
        Command::Fill(args) => cli::interaction::dispatch_fill(args, format),
        Command::Press(args) => cli::interaction::dispatch_press(args, format),
        Command::Select(args) => cli::interaction::dispatch_select(args, format),
        Command::Evaluate(args) => cli::evaluate::dispatch(args, format),
        Command::WaitForNavigation(args) => cli::waits::dispatch_wait_for_navigation(args, format),
        Command::WaitMs(args) => cli::waits::dispatch_wait_ms(args, format),
        Command::RequestHelp(args) => cli::human_loop::dispatch(args, format),
    }
}

fn init_cli_tracing(flags: &bsk::cli::GlobalFlags) {
    use tracing_subscriber::EnvFilter;
    let level = if flags.quiet {
        "warn"
    } else {
        match flags.verbose {
            0 => "info",
            1 => "debug",
            _ => "trace",
        }
    };
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(format!("bsk={level}")));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .try_init();
}
