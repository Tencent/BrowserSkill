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
    let mut file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let (start, len) = tail_snapshot(&mut file, n)?;
    file.seek(SeekFrom::Start(start))?;
    // Appends after this snapshot belong to the following poll, including
    // appends that arrive while the initial output is being written.
    let mut reader = BufReader::new(file.take(len - start));
    let mut line = Vec::new();
    let mut offset = start;
    loop {
        let count = reader.read_until(b'\n', &mut line)?;
        if count == 0 {
            break;
        }
        offset += count as u64;
        if line.last() == Some(&b'\n') {
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
        }
        writeln!(w, "{}", String::from_utf8_lossy(&line))?;
        line.clear();
    }
    w.flush()?;
    Ok(offset)
}

fn tail_snapshot(reader: &mut (impl Read + Seek), n: usize) -> std::io::Result<(u64, u64)> {
    for _ in 0..3 {
        let len = reader.seek(SeekFrom::End(0))?;
        match tail_start(reader, len, n) {
            Ok(start) => return Ok((start, len)),
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => continue,
            Err(error) => return Err(error),
        }
    }
    // A repeatedly truncated file has no stable tail yet. Leave its contents
    // for the next follow poll, starting at zero so no records are skipped.
    Ok((0, 0))
}

fn tail_start(reader: &mut (impl Read + Seek), len: u64, n: usize) -> std::io::Result<u64> {
    if n == 0 {
        return Ok(len);
    }
    let mut remaining = n;
    let mut end = len;
    let mut chunk = [0u8; 8192];
    while end > 0 {
        let start = end.saturating_sub(chunk.len() as u64);
        let count = (end - start) as usize;
        reader.seek(SeekFrom::Start(start))?;
        reader.read_exact(&mut chunk[..count])?;
        for index in (0..count).rev() {
            let position = start + index as u64;
            if chunk[index] == b'\n' && position != len - 1 {
                remaining -= 1;
                if remaining == 0 {
                    return Ok(position + 1);
                }
            }
        }
        end = start;
    }
    Ok(0)
}

fn print_appended<W: Write>(mut file: File, mut offset: u64, w: &mut W) -> Result<u64> {
    if file.metadata()?.len() < offset {
        // A truncated file starts a new stream at byte zero.
        offset = 0;
    }
    file.seek(SeekFrom::Start(offset))?;
    let copied = std::io::copy(&mut file, w)?;
    w.flush()?;
    Ok(offset + copied)
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
        let file = match File::open(&current) {
            Ok(f) => f,
            Err(_) => continue,
        };
        offset = print_appended(file, offset, w)?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::OpenOptions;
    use std::io::{self, Cursor};

    #[test]
    fn tail_handles_empty_files_line_endings_and_unicode() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("daemon.log");
        for (input, n, expected) in [
            ("", 1, ""),
            ("first\nsecond\n", 0, ""),
            ("first\nsecond\n", 1, "second\n"),
            ("first\nsecond", 1, "second\n"),
            ("first\nsecond\n", usize::MAX, "first\nsecond\n"),
            ("first\n\n", 1, "\n"),
            ("\n", 1, "\n"),
            ("first\r\nsecond\r\n", 1, "second\n"),
            ("first\r\nsecond\r", 1, "second\r\n"),
            ("first\n中文 🦀\n", 1, "中文 🦀\n"),
        ] {
            std::fs::write(&path, input).unwrap();
            let mut output = Vec::new();
            let offset = print_tail_lines(&path, n, &mut output).unwrap();
            assert_eq!(output, expected.as_bytes(), "input={input:?}, n={n}");
            assert_eq!(offset, input.len() as u64);
        }
    }

    #[test]
    fn tail_finds_boundaries_across_chunks_without_splitting_unicode() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("daemon.log");
        let expected = format!("{}\nlast\n", "界".repeat(5000));
        std::fs::write(&path, format!("{}\n{expected}", "prefix".repeat(2000))).unwrap();
        let mut output = Vec::new();
        print_tail_lines(&path, 2, &mut output).unwrap();
        assert_eq!(output, expected.as_bytes());
    }

    #[test]
    fn tail_reads_only_a_small_suffix_when_few_lines_are_requested() {
        struct CountingReader {
            cursor: Cursor<Vec<u8>>,
            bytes_read: usize,
        }
        impl Read for CountingReader {
            fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
                let count = self.cursor.read(buf)?;
                self.bytes_read += count;
                Ok(count)
            }
        }
        impl Seek for CountingReader {
            fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
                self.cursor.seek(position)
            }
        }
        let contents = "old line\n".repeat(200_000) + "last line\n";
        let len = contents.len() as u64;
        let mut reader = CountingReader {
            cursor: Cursor::new(contents.into_bytes()),
            bytes_read: 0,
        };
        assert_eq!(tail_start(&mut reader, len, 0).unwrap(), len);
        assert_eq!(reader.bytes_read, 0);
        assert_eq!(tail_start(&mut reader, len, 1).unwrap(), len - 10);
        assert!(reader.bytes_read <= 16 * 1024);
    }

    struct ShrinkingReader {
        file: File,
        path: PathBuf,
        reads: usize,
        repeatedly: bool,
    }

    impl Read for ShrinkingReader {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.reads += 1;
            if self.repeatedly {
                self.file
                    .set_len(self.file.metadata()?.len().saturating_sub(1))?;
            } else if self.reads == 2 {
                std::fs::write(&self.path, b"new\n")?;
            }
            self.file.read(buf)
        }
    }

    impl Seek for ShrinkingReader {
        fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
            self.file.seek(position)
        }
    }

    #[test]
    fn tail_resnapshots_when_truncated_during_the_backward_scan() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("daemon.log");
        std::fs::write(&path, "old".repeat(10_000)).unwrap();
        let mut reader = ShrinkingReader {
            file: File::open(&path).unwrap(),
            path,
            reads: 0,
            repeatedly: false,
        };
        let (start, len) = tail_snapshot(&mut reader, 1).unwrap();
        assert_eq!((start, len), (0, 4));
        let mut output = Vec::new();
        let offset = print_appended(reader.file, start, &mut output).unwrap();
        assert_eq!(output, b"new\n");
        assert_eq!(offset, len);
    }

    #[test]
    fn repeated_truncation_defers_to_following_without_skipping_content() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("daemon.log");
        std::fs::write(&path, b"continually shrinking").unwrap();
        let mut reader = ShrinkingReader {
            file: OpenOptions::new()
                .read(true)
                .write(true)
                .open(&path)
                .unwrap(),
            path: path.clone(),
            reads: 0,
            repeatedly: true,
        };
        assert_eq!(tail_snapshot(&mut reader, 1).unwrap(), (0, 0));
        assert!(
            reader.reads <= 8,
            "the initial scan must not retry indefinitely"
        );
        let mut output = Vec::new();
        print_appended(reader.file, 0, &mut output).unwrap();
        assert!(!output.is_empty());
        assert_eq!(output, std::fs::read(path).unwrap());
    }

    struct AppendingWriter {
        path: PathBuf,
        output: Vec<u8>,
        appended: bool,
    }

    impl Write for AppendingWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.output.extend_from_slice(buf);
            if !self.appended {
                self.appended = true;
                OpenOptions::new()
                    .append(true)
                    .open(&self.path)?
                    .write_all(b"second\n")?;
            }
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn initial_tail_leaves_concurrent_appends_for_the_next_poll() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("daemon.log");
        std::fs::write(&path, b"first\n").unwrap();
        let mut writer = AppendingWriter {
            path: path.clone(),
            output: Vec::new(),
            appended: false,
        };
        let offset = print_tail_lines(&path, 1, &mut writer).unwrap();
        assert_eq!(writer.output, b"first\n");
        let offset = print_appended(File::open(&path).unwrap(), offset, &mut writer).unwrap();
        print_appended(File::open(&path).unwrap(), offset, &mut writer).unwrap();
        assert_eq!(writer.output, b"first\nsecond\n");
    }

    #[test]
    fn following_advances_past_bytes_appended_during_output() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("daemon.log");
        std::fs::write(&path, b"first\n").unwrap();
        let mut writer = AppendingWriter {
            path: path.clone(),
            output: Vec::new(),
            appended: false,
        };
        let offset = print_appended(File::open(&path).unwrap(), 0, &mut writer).unwrap();
        assert_eq!(offset, b"first\nsecond\n".len() as u64);
        print_appended(File::open(&path).unwrap(), offset, &mut writer).unwrap();
        assert_eq!(writer.output, b"first\nsecond\n");
    }

    #[test]
    fn following_rewinds_a_truncated_file() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("daemon.log");
        std::fs::write(&path, b"old first\nold second\n").unwrap();
        let mut output = Vec::new();
        let offset = print_tail_lines(&path, 0, &mut output).unwrap();
        std::fs::write(&path, b"new\n").unwrap();
        let offset = print_appended(File::open(&path).unwrap(), offset, &mut output).unwrap();
        assert_eq!(offset, 4);
        assert_eq!(output, b"new\n");
    }

    #[test]
    fn output_write_and_flush_errors_end_log_reading() {
        struct FailingWriter {
            fail_on_flush: bool,
        }
        impl Write for FailingWriter {
            fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
                if self.fail_on_flush {
                    Ok(buf.len())
                } else {
                    Err(io::ErrorKind::BrokenPipe.into())
                }
            }
            fn flush(&mut self) -> io::Result<()> {
                Err(io::ErrorKind::BrokenPipe.into())
            }
        }
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("daemon.log");
        std::fs::write(&path, b"first\n").unwrap();
        for fail_on_flush in [false, true] {
            let mut writer = FailingWriter { fail_on_flush };
            let error = print_tail_lines(&path, 1, &mut writer).unwrap_err();
            assert_eq!(
                error.downcast_ref::<io::Error>().unwrap().kind(),
                io::ErrorKind::BrokenPipe
            );
            let error = print_appended(File::open(&path).unwrap(), 0, &mut writer).unwrap_err();
            assert_eq!(
                error.downcast_ref::<io::Error>().unwrap().kind(),
                io::ErrorKind::BrokenPipe
            );
        }
    }
}
