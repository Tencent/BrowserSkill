//! `bsk logs` — print the most recent daemon log file, optionally
//! following it.

use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};

use crate::daemon::paths;

#[derive(Debug, Clone)]
pub struct LogsArgs {
    pub follow: bool,
    pub lines: usize,
}

impl Default for LogsArgs {
    fn default() -> Self {
        Self {
            follow: false,
            lines: 200,
        }
    }
}

/// Find the newest log file produced by the rolling appender. Files
/// are named `daemon.log.YYYY-MM-DD`; we pick the lexicographically
/// largest one matching the prefix.
pub fn latest_log_file() -> Result<Option<PathBuf>> {
    let dir = paths::log_dir()?;
    if !dir.exists() {
        return Ok(None);
    }
    let mut best: Option<(String, PathBuf)> = None;
    for entry in std::fs::read_dir(&dir).context("read bsk home dir")? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with("daemon.log") {
            continue;
        }
        if let Some((cur, _)) = &best {
            if name <= *cur {
                continue;
            }
        }
        best = Some((name, entry.path()));
    }
    Ok(best.map(|(_, p)| p))
}

pub fn run(args: LogsArgs) -> Result<()> {
    let Some(path) = latest_log_file()? else {
        eprintln!("no log files in {}", paths::log_dir()?.display());
        return Ok(());
    };

    let stdout = std::io::stdout();
    let mut stdout = stdout.lock();

    // Print last N lines.
    let initial_len = print_tail_lines(&path, args.lines, &mut stdout)?;

    if !args.follow {
        return Ok(());
    }

    follow_file(&path, initial_len, &mut stdout)
}

fn print_tail_lines<W: Write>(path: &Path, n: usize, w: &mut W) -> Result<u64> {
    let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let len = file.metadata()?.len();
    let mut reader = BufReader::new(file);
    let mut buf: Vec<u8> = Vec::new();
    reader.read_to_end(&mut buf)?;

    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<&str> = text.lines().collect();
    let start = lines.len().saturating_sub(n);
    lines.drain(0..start);
    for line in lines {
        writeln!(w, "{line}")?;
    }
    Ok(len)
}

fn follow_file<W: Write>(path: &Path, mut offset: u64, w: &mut W) -> Result<()> {
    let mut current = path.to_path_buf();
    loop {
        std::thread::sleep(Duration::from_millis(200));
        if let Ok(Some(latest)) = latest_log_file() {
            if latest != current {
                current = latest;
                offset = 0;
            }
        }
        let mut file = match File::open(&current) {
            Ok(f) => f,
            Err(_) => continue,
        };
        let len = file.metadata()?.len();
        if len < offset {
            // File truncated or rotated; rewind.
            offset = 0;
        }
        if len == offset {
            continue;
        }
        file.seek(SeekFrom::Start(offset))?;
        let mut reader = BufReader::new(file);
        let mut line = String::new();
        while reader.read_line(&mut line)? > 0 {
            let _ = w.write_all(line.as_bytes());
            line.clear();
        }
        offset = len;
        let _ = w.flush();
    }
}
