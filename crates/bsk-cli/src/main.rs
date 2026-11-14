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
    let is_multi_phase = cli::validate_command_evidence(&cli.command, &cli.flags)?;
    cli::business_rpc::set_caller_scope(cli.flags.scope.clone());
    // Plans and recipes attach evidence step by step, so it never goes on every request.
    if !matches!(cli.command, Command::Plan(_) | Command::Recipe(_)) {
        if is_multi_phase {
            cli::business_rpc::set_multi_phase_command();
        }
        cli::business_rpc::set_context(cli.flags.context.clone());
        cli::business_rpc::set_dependencies(cli.flags.depends_on.clone());
        cli::business_rpc::set_action_evidence(
            cli.flags.observation.clone(),
            cli.flags.expect.clone(),
        );
    }
    match cli.command {
        Command::Open(args) => cli::lifecycle::dispatch_open(args, format),
        Command::Sync(args) => cli::lifecycle::dispatch_sync(args, format),
        Command::Close(args) => cli::lifecycle::dispatch_close(args, format),
        Command::Ledger(cmd) => cli::ledger::dispatch(cmd, format),
        Command::Cooperate(args) => cli::cooperate::dispatch(args, format),
        Command::Step(args) => cli::step::dispatch(args, format),
        Command::Plan(args) => cli::plan::dispatch(args, &cli.flags, format),
        Command::Recipe(cmd) => cli::recipe::dispatch(cmd, &cli.flags, format),
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
        Command::Session(cmd) => cli::session::dispatch(cmd, format),
        Command::Browsers => cli::browsers::dispatch(format),
        Command::Tab(cmd) => cli::tab::dispatch(cmd, format),
        Command::Window(cmd) => cli::window::dispatch(cmd, format),
        Command::Emulate(args) => cli::emulate::dispatch(args, format),
        Command::Screenshot(args) => cli::screenshot::dispatch(args, format),
        Command::Snapshot(args) => cli::snapshot::dispatch(args, format),
        Command::Observe(args) => cli::observe::dispatch(args, format),
        Command::Console(args) => cli::console::dispatch(args, format),
        Command::Debug(args) => cli::debug::dispatch(*args, format),
        Command::Network(args) => cli::network::dispatch(args, format),
        Command::GetHtml(args) => cli::get_html::dispatch(args, format),
        Command::Read(args) => cli::read::dispatch(args, format),
        Command::Extract(args) => cli::extract::dispatch(args, format),
        Command::Navigate(args) => cli::navigate::dispatch_navigate_command(args, format),
        Command::NavigateBack(args) => cli::navigate::dispatch_navigate_back(args, format),
        Command::NavigateForward(args) => cli::navigate::dispatch_navigate_forward(args, format),
        Command::Reload(args) => cli::navigate::dispatch_reload(args, format),
        Command::Click(args) => cli::interaction::dispatch_click(args, format),
        Command::Hover(args) => cli::interaction::dispatch_hover(args, format),
        Command::Drag(args) => cli::drag::dispatch(args, format),
        Command::Wheel(args) => cli::wheel::dispatch(args, format),
        Command::ScrollTo(args) => cli::scroll::dispatch(args, format),
        Command::Focus(args) => cli::interaction::dispatch_focus(args, format),
        Command::Blur(args) => cli::interaction::dispatch_blur(args, format),
        Command::Fill(args) => cli::interaction::dispatch_fill(args, format),
        Command::Press(args) => cli::interaction::dispatch_press(args, format),
        Command::Select(args) => cli::interaction::dispatch_select(args, format),
        Command::Upload(args) => cli::upload::dispatch(args, format),
        Command::Download(args) => cli::download::dispatch(args, format),
        Command::Evaluate(args) => cli::evaluate::dispatch(args, format),
        Command::WaitForNavigation(args) => cli::waits::dispatch_wait_for_navigation(args, format),
        Command::WaitForElement(args) => cli::waits::dispatch_wait_for_element(args, format),
        Command::WaitMs(args) => cli::waits::dispatch_wait_ms(args, format),
        Command::RequestHelp(args) => cli::human_loop::dispatch(args, format),
        Command::Record(cmd) => cli::record::dispatch(cmd, format),
        Command::Dialog(cmd) => cli::dialog_control::dispatch_dialog(cmd, format),
        Command::Operation(cmd) => cli::dialog_control::dispatch_operation(cmd, format),
        Command::Video(cmd) => cli::video::dispatch(cmd, format),
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
