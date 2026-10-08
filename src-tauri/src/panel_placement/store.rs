use std::fmt;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::state::{Corner, PlacementSnapshot};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlacementPosition {
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlacementRecord {
    pub version: u32,
    pub position: PlacementPosition,
    #[serde(deserialize_with = "Option::deserialize")]
    pub corner: Option<Corner>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoadOutcome {
    Stored(PlacementRecord),
    Missing,
    Corrupt(String),
}

#[derive(Debug)]
pub enum StoreError {
    Io(io::Error),
    Serialize(serde_json::Error),
    ConcurrentWrite { generation: u64, latest: u64 },
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(f, "placement storage I/O failed: {error}"),
            Self::Serialize(error) => write!(f, "placement storage serialization failed: {error}"),
            Self::ConcurrentWrite { generation, latest } => write!(
                f, "stale placement generation {generation} cannot replace {latest}"
            ),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<io::Error> for StoreError {
    fn from(error: io::Error) -> Self { Self::Io(error) }
}

impl From<serde_json::Error> for StoreError {
    fn from(error: serde_json::Error) -> Self { Self::Serialize(error) }
}

/// Serializes same-directory atomic writes. Runtime generations never enter
/// the durable record; the watermark only rejects stale writes in this process.
pub struct PlacementStore {
    path: PathBuf,
    writes: Mutex<Option<u64>>,
}

impl PlacementStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path, writes: Mutex::new(None) }
    }

    pub fn load(&self) -> Result<LoadOutcome, StoreError> {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(LoadOutcome::Missing),
            Err(error) => return Err(error.into()),
        };
        match serde_json::from_slice::<PlacementRecord>(&bytes) {
            Ok(record) if record.version == 1 => Ok(LoadOutcome::Stored(record)),
            Ok(record) => Ok(LoadOutcome::Corrupt(format!("unsupported placement version {}", record.version))),
            Err(error) => Ok(LoadOutcome::Corrupt(error.to_string())),
        }
    }

    pub fn save_confirmed(&self, snapshot: &PlacementSnapshot) -> Result<(), StoreError> {
        let mut latest = self.writes.lock().expect("placement store lock poisoned");
        if let Some(generation) = *latest {
            if snapshot.generation < generation {
                return Err(StoreError::ConcurrentWrite { generation: snapshot.generation, latest: generation });
            }
        }
        let record = PlacementRecord {
            version: 1,
            position: PlacementPosition { x: snapshot.frame.x, y: snapshot.frame.y },
            corner: snapshot.corner,
        };
        let parent = self.path.parent().filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(parent)?;
        let mut temp = tempfile::NamedTempFile::new_in(parent)?;
        temp.write_all(&serde_json::to_vec(&record)?)?;
        temp.as_file().sync_all()?;
        temp.persist(&self.path).map_err(|error| error.error)?;
        *latest = Some(snapshot.generation);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::panel_placement::state::{Corner, PhysicalFrame, PlacementSnapshot};

    #[test]
    fn saves_and_loads_only_durable_confirmed_fields() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("placement.json");
        let store = PlacementStore::new(path.clone());
        let snapshot = PlacementSnapshot {
            generation: 7,
            corner: Some(Corner::BottomLeft),
            frame: PhysicalFrame { x: -1904, y: 812, width: 420, height: 252 },
        };
        store.save_confirmed(&snapshot).unwrap();
        assert!(matches!(store.load().unwrap(), LoadOutcome::Stored(record)
            if record.version == 1 && record.position.x == -1904
                && record.position.y == 812 && record.corner == Some(Corner::BottomLeft)));
        let text = std::fs::read_to_string(path).unwrap();
        assert!(!text.contains("generation"));
        assert!(!text.contains("width"));
        assert!(!text.contains("height"));
    }

    #[test]
    fn corrupt_bytes_are_reported_and_left_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("placement.json");
        let store = PlacementStore::new(path.clone());
        std::fs::write(&path, b"{invalid").unwrap();
        assert!(matches!(store.load().unwrap(), LoadOutcome::Corrupt(_)));
        assert_eq!(std::fs::read(&path).unwrap(), b"{invalid");
    }

    #[test]
    fn rejected_directory_write_does_not_change_existing_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("placement.json");
        std::fs::write(&path, b"old").unwrap();
        let snapshot = PlacementSnapshot {
            generation: 1,
            corner: Some(Corner::TopLeft),
            frame: PhysicalFrame { x: 1, y: 2, width: 3, height: 4 },
        };
        // A path whose parent is a regular file cannot create a temp file.
        let blocked = PlacementStore::new(path.join("child").join("placement.json"));
        assert!(blocked.save_confirmed(&snapshot).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"old");
    }

    #[test]
    fn stale_generation_cannot_overwrite_newer_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("placement.json");
        let store = PlacementStore::new(path.clone());
        let frame = |x| PhysicalFrame { x, y: 2, width: 3, height: 4 };
        store.save_confirmed(&PlacementSnapshot { generation: 2, corner: None, frame: frame(2) }).unwrap();
        assert!(matches!(store.save_confirmed(&PlacementSnapshot { generation: 1, corner: None, frame: frame(1) }),
            Err(StoreError::ConcurrentWrite { .. })));
        assert!(matches!(store.load().unwrap(), LoadOutcome::Stored(record) if record.position.x == 2));
    }

    #[test]
    fn missing_file_is_distinct_from_corrupt_and_unsupported_version() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("placement.json");
        let store = PlacementStore::new(path.clone());
        assert_eq!(store.load().unwrap(), LoadOutcome::Missing);
        let unsupported = br#"{"version":2,"position":{"x":1,"y":2},"corner":null}"#;
        std::fs::write(&path, unsupported).unwrap();
        assert!(matches!(store.load().unwrap(), LoadOutcome::Corrupt(reason)
            if reason.contains("version")));
        assert_eq!(std::fs::read(path).unwrap(), unsupported);
    }

    #[test]
    fn missing_nullable_corner_is_corrupt_instead_of_free_position() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("placement.json");
        let bytes = br#"{"version":1,"position":{"x":1,"y":2}}"#;
        std::fs::write(&path, bytes).unwrap();
        assert!(matches!(PlacementStore::new(path.clone()).load().unwrap(), LoadOutcome::Corrupt(_)));
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
}
