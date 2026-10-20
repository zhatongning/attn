use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use serde::Deserialize;
use std::env;
use std::error::Error;
use std::fs;
use std::io::{Error as IoError, ErrorKind};
use std::path::PathBuf;

#[derive(Deserialize)]
struct TauriConfig {
    plugins: Plugins,
}

#[derive(Deserialize)]
struct Plugins {
    updater: UpdaterConfig,
}

#[derive(Deserialize)]
struct UpdaterConfig {
    pubkey: String,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Updater signature verification failed: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let mut arguments = env::args_os();
    let _program = arguments.next();
    let archive = PathBuf::from(arguments.next().ok_or_else(|| {
        IoError::new(ErrorKind::InvalidInput, "expected updater archive path")
    })?);
    let signature = PathBuf::from(arguments.next().ok_or_else(|| {
        IoError::new(ErrorKind::InvalidInput, "expected updater signature path")
    })?);
    if arguments.next().is_some() {
        return Err(IoError::new(
            ErrorKind::InvalidInput,
            "expected only an updater archive and signature path",
        )
        .into());
    }

    let config: TauriConfig = serde_json::from_str(include_str!("../tauri.conf.json"))?;
    let public_key_text = String::from_utf8(
        base64::engine::general_purpose::STANDARD.decode(config.plugins.updater.pubkey.trim())?,
    )?;
    let public_key = PublicKey::decode(&public_key_text)?;
    let signature_text = String::from_utf8(base64::engine::general_purpose::STANDARD.decode(
        fs::read_to_string(&signature)?.trim(),
    )?)?;
    let signature = Signature::decode(&signature_text)?;

    public_key.verify(&fs::read(&archive)?, &signature, true)?;
    println!("Verified updater signature: {}", archive.display());
    Ok(())
}
