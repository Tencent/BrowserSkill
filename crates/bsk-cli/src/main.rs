use std::process::ExitCode;

use clap::Parser;

use bsk::cli::error::{CliError, Format, render, render_parse_error};
use bsk::cli::status::Output;
use bsk::{Cli, Command, cli};

fn main() -> ExitCode {
    let args: Vec<_> = std::env::args_os().collect();
    let cli = match Cli::try_parse_from(&args) {
        Ok(cli) => cli,
        Err(err) => return render_parse_error(err, &args),
    };

    // The daemon installs its own subscriber (with the rolling file
    // appender); CLI tracing would race with it and silently win, so
    // only init the CLI-side stderr subscriber for client commands, including
    // daemon maintenance. Start/restart own the daemon's logging setup.
    if !matches!(
        cli.command,
        Command::Daemon(cli::daemon::DaemonCmd::Start(_) | cli::daemon::DaemonCmd::Restart(_))
    ) {
        init_cli_tracing(&cli.flags);
    }
    cli::update::print_update_hint_from_cache(&cli.flags, &cli.command);

    // Even startup/shutdown errors must not corrupt MCP's JSON-RPC stdout.
    let format = if cli.flags.json && !matches!(cli.command, Command::Mcp(_)) {
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
    let base_ctx = cli::business_rpc::ClientContext::from_cli_flags(&cli.flags);
    // Plans and recipes attach evidence step by step, so it never goes on every request.
    let step_ctx = base_ctx.without_action_metadata();
    match cli.command {
        Command::Open(args) => cli::lifecycle::dispatch_open(args, &base_ctx, format),
        Command::Sync(args) => cli::lifecycle::dispatch_sync(args, &base_ctx, format),
        Command::Close(args) => cli::lifecycle::dispatch_close(args, &base_ctx, format),
        Command::Ledger(cmd) => cli::ledger::dispatch(cmd, &base_ctx, format),
        Command::Cooperate(args) => cli::cooperate::dispatch(args, &base_ctx, format),
        Command::Step(args) => cli::step::dispatch(args, &base_ctx, format),
        Command::Plan(args) => cli::plan::dispatch(args, &cli.flags, &step_ctx, format),
        Command::Recipe(cmd) => cli::recipe::dispatch(cmd, &cli.flags, &step_ctx, format),
        Command::View(args) => cli::observation_view::dispatch(args, format),
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
            let checks = cli::doctor::run(output).map_err(CliError::Local)?;
            if cli::doctor::has_failures(&checks) {
                Err(CliError::RenderedExit { exit_code: 1 })
            } else {
                Ok(())
            }
        }
        Command::InstallSkill(args) => {
            let output = if cli.flags.json {
                Output::Json
            } else {
                Output::Human
            };
            cli::install_skill::dispatch(args, output)
        }
        Command::Update(args) => cli::update::dispatch(args, format),
        Command::Logs(cmd) => cli::logs::run(cli::logs::LogsArgs {
            follow: cmd.follow,
            lines: cmd.lines,
        })
        .map_err(CliError::Local),
        Command::Mcp(args) => cli::mcp::dispatch(args),
        Command::Session(cmd) => cli::session::dispatch(cmd, &base_ctx, format),
        Command::Browsers => cli::browsers::dispatch(format),
        Command::Tab(cmd) => cli::tab::dispatch(cmd, &base_ctx, format),
        Command::Window(cmd) => cli::window::dispatch(cmd, &base_ctx, format),
        Command::Emulate(args) => cli::emulate::dispatch(args, &base_ctx, format),
        Command::Screenshot(args) => cli::screenshot::dispatch(args, &base_ctx, format),
        Command::Snapshot(args) => cli::snapshot::dispatch(args, &base_ctx, format),
        Command::Observe(args) => cli::observe::dispatch(args, &base_ctx, format),
        Command::Console(args) => cli::console::dispatch(args, &base_ctx, format),
        Command::Debug(args) => cli::debug::dispatch(*args, &base_ctx, format),
        Command::Network(args) => cli::network::dispatch(args, &base_ctx, format),
        Command::GetHtml(args) => cli::get_html::dispatch(args, &base_ctx, format),
        Command::Read(args) => cli::read::dispatch(args, &base_ctx, format),
        Command::Extract(args) => cli::extract::dispatch(args, &base_ctx, format),
        Command::Navigate(args) => {
            cli::navigate::dispatch_navigate_command(args, &base_ctx, format)
        }
        Command::NavigateBack(args) => {
            cli::navigate::dispatch_navigate_back(args, &base_ctx, format)
        }
        Command::NavigateForward(args) => {
            cli::navigate::dispatch_navigate_forward(args, &base_ctx, format)
        }
        Command::Reload(args) => cli::navigate::dispatch_reload(args, &base_ctx, format),
        Command::Click(args) => cli::interaction::dispatch_click(args, &base_ctx, format),
        Command::Hover(args) => cli::interaction::dispatch_hover(args, &base_ctx, format),
        Command::Drag(args) => cli::drag::dispatch(args, &base_ctx, format),
        Command::Wheel(args) => cli::wheel::dispatch(args, &base_ctx, format),
        Command::ScrollTo(args) => cli::scroll::dispatch(args, &base_ctx, format),
        Command::Focus(args) => cli::interaction::dispatch_focus(args, &base_ctx, format),
        Command::Blur(args) => cli::interaction::dispatch_blur(args, &base_ctx, format),
        Command::Fill(args) => cli::interaction::dispatch_fill(args, &base_ctx, format),
        Command::Press(args) => cli::interaction::dispatch_press(args, &base_ctx, format),
        Command::Select(args) => cli::interaction::dispatch_select(args, &base_ctx, format),
        Command::Upload(args) => cli::upload::dispatch(args, &base_ctx, format),
        Command::Download(args) => cli::download::dispatch(args, &base_ctx, format),
        Command::Evaluate(args) => cli::evaluate::dispatch(args, &base_ctx, format),
        Command::WaitForNavigation(args) => {
            cli::waits::dispatch_wait_for_navigation(args, &base_ctx, format)
        }
        Command::WaitForElement(args) => {
            cli::waits::dispatch_wait_for_element(args, &base_ctx, format)
        }
        Command::WaitMs(args) => cli::waits::dispatch_wait_ms(args, &base_ctx, format),
        Command::RequestHelp(args) => cli::human_loop::dispatch(args, &base_ctx, format),
        Command::Record(cmd) => cli::record::dispatch(cmd, &base_ctx, format),
        Command::Dialog(cmd) => cli::dialog_control::dispatch_dialog(cmd, &base_ctx, format),
        Command::Operation(cmd) => cli::dialog_control::dispatch_operation(cmd, &base_ctx, format),
        Command::Video(cmd) => cli::video::dispatch(cmd, &base_ctx, format),
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
