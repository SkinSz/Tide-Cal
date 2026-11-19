// Size-capped rotating log file with numbered archives.
//
// Why not tauri-plugin-log's own file target: its archive names have
// one-second resolution, and a second rotation within the same second turns
// the older archive into `<name>.log.bak`, which its pruning never removes.
// A log storm can then grow the folder ~1 MiB/s (independent review 2026-11-13,
// F1). Numbered archives make the ceiling unconditional:
//
//   tide.log  (active)  tide.1.log (newest archive) … tide.<keep>.log
//   disk use ≤ (keep + 1) × max_bytes + one record
//
// Failure policy: logging must never take the app down or grow memory. Any
// I/O error drops the pending record and retries opening on the next one.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

pub struct RotatingLog {
    dir: PathBuf,
    stem: String,
    max_bytes: u64,
    keep: usize,
    file: Option<File>,
    size: u64,
    pending: Vec<u8>,
}

impl RotatingLog {
    /// Never fails: the directory/file is created lazily on first write.
    pub fn new(dir: PathBuf, stem: &str, max_bytes: u64, keep: usize) -> Self {
        RotatingLog {
            dir,
            stem: stem.to_string(),
            max_bytes,
            keep,
            file: None,
            size: 0,
            pending: Vec::new(),
        }
    }

    fn active(&self) -> PathBuf {
        self.dir.join(format!("{}.log", self.stem))
    }

    fn archive(&self, n: usize) -> PathBuf {
        self.dir.join(format!("{}.{n}.log", self.stem))
    }

    fn open(&mut self) -> io::Result<()> {
        fs::create_dir_all(&self.dir)?;
        let f = OpenOptions::new().create(true).append(true).open(self.active())?;
        self.size = f.metadata()?.len();
        self.file = Some(f);
        Ok(())
    }

    fn rotate(&mut self) -> io::Result<()> {
        self.file = None; // close before renaming (required on Windows)
        let _ = fs::remove_file(self.archive(self.keep));
        for n in (1..self.keep).rev() {
            let from = self.archive(n);
            if from.exists() {
                let _ = fs::rename(&from, self.archive(n + 1));
            }
        }
        if self.keep == 0 || fs::rename(self.active(), self.archive(1)).is_err() {
            // keep == 0, or the active file is locked by another program:
            // truncate in place so the size bound still holds.
            OpenOptions::new().write(true).truncate(true).open(self.active())?;
        }
        self.open()
    }

    fn write_pending(&mut self) -> io::Result<()> {
        if self.file.is_none() {
            self.open()?;
        }
        if self.size > 0 && self.size + self.pending.len() as u64 > self.max_bytes {
            self.rotate()?;
        }
        if let Some(f) = self.file.as_mut() {
            f.write_all(&self.pending)?;
            f.flush()?;
            self.size += self.pending.len() as u64;
        }
        Ok(())
    }
}

impl Write for RotatingLog {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        // Bound memory AND the per-file size: a record never exceeds
        // max_bytes (an oversized record is truncated), even if flush is
        // never called between writes.
        let room = (self.max_bytes as usize).saturating_sub(self.pending.len());
        self.pending.extend_from_slice(&buf[..buf.len().min(room)]);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        if self.pending.is_empty() {
            return Ok(());
        }
        if self.write_pending().is_err() {
            self.file = None; // reopen on the next record
        }
        self.pending.clear(); // dropped on error: never accumulate
        Ok(())
    }
}

/// Remove log files left by earlier schemes in OUR log folder: plugin-style
/// dated archives (`tide_<date>.log`, `….log.bak`) and the plugin's default
/// `Tide.log` / `Tide_<date>.log` names. Numbered archives are untouched.
pub fn prune_legacy_logs(dir: &Path, stem: &str) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_legacy_log(&name, stem) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

fn is_legacy_log(name: &str, stem: &str) -> bool {
    let lower = name.to_lowercase();
    let dated = lower.starts_with(&format!("{stem}_"));
    let plugin_default = lower == "tide.log" && name != format!("{stem}.log");
    (dated && (lower.ends_with(".log") || lower.ends_with(".log.bak"))) || plugin_default
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("tide-logfile-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    fn files(dir: &Path) -> Vec<(String, u64)> {
        let mut v: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| (e.file_name().to_string_lossy().into_owned(), e.metadata().unwrap().len()))
            .collect();
        v.sort();
        v
    }

    #[test]
    fn storm_stays_within_hard_ceiling() {
        // 20 MiB written as fast as possible (same second, many rotations).
        let dir = tmp("storm");
        let (max, keep) = (64 * 1024u64, 4usize);
        let mut log = RotatingLog::new(dir.clone(), "tide", max, keep);
        let record = vec![b'x'; 1000];
        for _ in 0..20_000 {
            log.write_all(&record).unwrap();
            log.flush().unwrap();
        }
        let fs_ = files(&dir);
        let total: u64 = fs_.iter().map(|f| f.1).sum();
        fs::remove_dir_all(&dir).ok();
        assert_eq!(fs_.len(), keep + 1, "{fs_:?}");
        assert!(total <= (keep as u64 + 1) * max, "total {total} > ceiling");
        assert!(fs_.iter().all(|(n, _)| n == "tide.log" || n.starts_with("tide.") && n.ends_with(".log")));
    }

    #[test]
    fn oversized_single_record_cannot_break_the_ceiling() {
        let dir = tmp("huge");
        let (max, keep) = (4096u64, 2usize);
        let mut log = RotatingLog::new(dir.clone(), "tide", max, keep);
        for _ in 0..5 {
            log.write_all(&vec![b'h'; 10 * 1024 * 1024]).unwrap(); // 10 MiB record
            log.flush().unwrap();
        }
        let total: u64 = files(&dir).iter().map(|f| f.1).sum();
        fs::remove_dir_all(&dir).ok();
        assert!(total <= (keep as u64 + 1) * max, "total {total}");
    }

    #[test]
    fn unwritable_dir_never_errors_or_grows_memory() {
        // A regular FILE where the directory should be: every open fails.
        let base = tmp("blocked");
        fs::create_dir_all(&base).unwrap();
        let blocker = base.join("logs");
        fs::write(&blocker, b"not a dir").unwrap();
        let mut log = RotatingLog::new(blocker, "tide", 1024, 2);
        for _ in 0..10_000 {
            log.write_all(&[b'y'; 100]).unwrap();
            log.flush().unwrap();
        }
        assert!(log.pending.is_empty());
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn legacy_names_are_pruned_numbered_kept() {
        let dir = tmp("legacy");
        fs::create_dir_all(&dir).unwrap();
        for f in [
            "tide.log", "tide.1.log", "tide_2026-11-13_21-00-00.log",
            "tide_2026-11-13_21-00-00.log.bak", "Tide.log", "notes.txt",
        ] {
            fs::write(dir.join(f), b"x").unwrap();
        }
        prune_legacy_logs(&dir, "tide");
        let left: Vec<String> = files(&dir).into_iter().map(|f| f.0).collect();
        fs::remove_dir_all(&dir).ok();
        // Case-insensitive filesystems (Windows) see "Tide.log" == "tide.log";
        // on Linux they are distinct and the plugin-default one goes.
        assert_eq!(left, ["notes.txt", "tide.1.log", "tide.log"]);
    }
}
