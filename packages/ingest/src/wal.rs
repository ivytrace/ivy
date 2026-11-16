//! Write-ahead log per shard: accepted rows are appended to a segment file before the client gets 200, and a
//! flusher inserts sealed segments into ClickHouse, deleting each only after its insert succeeded. Segments left
//! by a previous process are replayed on start. Delivery is at least once (a crash between insert and delete
//! inserts that segment again), like the collector's persistent queue.
//!
//! Segment format: frames of `u32 little-endian length` + RowBinary rows. A frame cut short by a crash is dropped.

use crate::clickhouse::Client;
use bytes::Bytes;
use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;

const SEGMENT_MAX_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug)]
pub enum AppendError {
    /// Over the size limit: ClickHouse is behind.
    Full,
    Io(std::io::Error),
}

struct State {
    file: File,
    seq: u64,
    current_bytes: u64,
    sealed: VecDeque<(u64, u64)>,
    total_bytes: u64,
}

pub struct Wal {
    dir: PathBuf,
    max_bytes: u64,
    state: Mutex<State>,
    rotated: Notify,
}

fn segment_path(dir: &Path, seq: u64) -> PathBuf {
    dir.join(format!("{seq:020}.seg"))
}

fn open_segment(dir: &Path, seq: u64) -> std::io::Result<File> {
    OpenOptions::new().create(true).append(true).open(segment_path(dir, seq))
}

impl Wal {
    pub fn open(dir: PathBuf, max_bytes: u64) -> std::io::Result<Arc<Wal>> {
        fs::create_dir_all(&dir)?;
        let mut existing: Vec<(u64, u64)> = fs::read_dir(&dir)?
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let name = e.file_name().into_string().ok()?;
                let seq = name.strip_suffix(".seg")?.parse().ok()?;
                Some((seq, e.metadata().ok()?.len()))
            })
            .collect();
        existing.sort();
        let seq = existing.last().map_or(0, |(s, _)| s + 1);
        let total_bytes = existing.iter().map(|(_, n)| n).sum();
        let file = open_segment(&dir, seq)?;
        Ok(Arc::new(Wal {
            dir,
            max_bytes,
            state: Mutex::new(State { file, seq, current_bytes: 0, sealed: existing.into(), total_bytes }),
            rotated: Notify::new(),
        }))
    }

    /// Appends one request's rows.
    pub fn append(&self, rows: &[u8]) -> Result<(), AppendError> {
        if rows.is_empty() {
            return Ok(());
        }
        let mut s = self.state.lock().unwrap();
        let len = rows.len() as u64 + 4;
        if s.total_bytes + len > self.max_bytes {
            return Err(AppendError::Full);
        }
        let mut frame = Vec::with_capacity(rows.len() + 4);
        frame.extend_from_slice(&(rows.len() as u32).to_le_bytes());
        frame.extend_from_slice(rows);
        s.file.write_all(&frame).map_err(AppendError::Io)?;
        s.current_bytes += len;
        s.total_bytes += len;
        if s.current_bytes >= SEGMENT_MAX_BYTES {
            self.seal(&mut s).map_err(AppendError::Io)?;
            self.rotated.notify_one();
        }
        Ok(())
    }

    fn seal(&self, s: &mut State) -> std::io::Result<()> {
        if s.current_bytes == 0 {
            return Ok(());
        }
        let next = open_segment(&self.dir, s.seq + 1)?;
        let (seq, bytes) = (s.seq, s.current_bytes);
        s.sealed.push_back((seq, bytes));
        s.file = next;
        s.seq += 1;
        s.current_bytes = 0;
        Ok(())
    }

    pub fn bytes(&self) -> u64 {
        self.state.lock().unwrap().total_bytes
    }

    /// Seals the current segment and inserts sealed segments in order until one fails.
    pub async fn flush(&self, client: &Client, database: &str) -> Result<usize, String> {
        self.seal(&mut self.state.lock().unwrap()).map_err(|e| e.to_string())?;
        let mut inserted = 0;
        loop {
            let Some((seq, bytes)) = self.state.lock().unwrap().sealed.front().copied() else { return Ok(inserted) };
            let path = segment_path(&self.dir, seq);
            let raw = tokio::fs::read(&path).await.map_err(|e| format!("{}: {e}", path.display()))?;
            let rows = unframe(&raw);
            if !rows.is_empty() {
                client.insert_row_binary(database, "otel_traces", crate::rows::COLUMNS, rows).await?;
            }
            let _ = tokio::fs::remove_file(&path).await;
            let mut s = self.state.lock().unwrap();
            s.sealed.pop_front();
            s.total_bytes = s.total_bytes.saturating_sub(bytes);
            inserted += 1;
        }
    }

    /// Flushes every `every` (or as soon as a segment fills up), backing off while ClickHouse fails.
    pub async fn run_flusher(self: Arc<Self>, client: Client, database: String, shard: String, every: Duration) {
        let mut backoff = Duration::from_secs(1);
        loop {
            tokio::select! {
                _ = tokio::time::sleep(every) => {}
                _ = self.rotated.notified() => {}
            }
            match self.flush(&client, &database).await {
                Ok(_) => backoff = Duration::from_secs(1),
                Err(e) => {
                    eprintln!("[ingest] insert into shard {shard} failed (retrying in {backoff:?}, {} bytes queued): {e}", self.bytes());
                    tokio::time::sleep(backoff).await;
                    backoff = (backoff * 2).min(Duration::from_secs(30));
                }
            }
        }
    }
}

/// The rows of every complete frame.
fn unframe(raw: &[u8]) -> Bytes {
    let mut out = Vec::with_capacity(raw.len());
    let mut pos = 0;
    while pos + 4 <= raw.len() {
        let len = u32::from_le_bytes(raw[pos..pos + 4].try_into().unwrap()) as usize;
        let Some(end) = (pos + 4).checked_add(len).filter(|&e| e <= raw.len()) else { break };
        out.extend_from_slice(&raw[pos + 4..end]);
        pos = end;
    }
    Bytes::from(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ivy-wal-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn appends_seals_and_replays() {
        let dir = temp_dir("replay");
        let wal = Wal::open(dir.clone(), 1 << 20).unwrap();
        wal.append(b"abc").unwrap();
        wal.append(b"de").unwrap();
        assert_eq!(wal.bytes(), 13);
        drop(wal);
        // A crash mid-write leaves a partial frame: it is dropped.
        let mut f = OpenOptions::new().append(true).open(segment_path(&dir, 0)).unwrap();
        f.write_all(&[9, 0, 0, 0, b'x']).unwrap();
        let wal = Wal::open(dir.clone(), 1 << 20).unwrap();
        let (seq, _) = wal.state.lock().unwrap().sealed[0];
        assert_eq!(&unframe(&fs::read(segment_path(&dir, seq)).unwrap())[..], b"abcde");
        assert_eq!(wal.state.lock().unwrap().seq, 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn refuses_when_full() {
        let dir = temp_dir("full");
        let wal = Wal::open(dir.clone(), 10).unwrap();
        assert!(wal.append(b"12345").is_ok());
        assert!(matches!(wal.append(b"12345"), Err(AppendError::Full)));
        fs::remove_dir_all(dir).unwrap();
    }
}
