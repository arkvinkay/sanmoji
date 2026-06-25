//! Windows `.smpr` file association — repairs installs where NSIS registration failed.

#[cfg(windows)]
const PROG_ID: &str = "SanMoji.smpr";

#[cfg(windows)]
fn open_command_exe_exists(command: &str) -> bool {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return false;
    }

    let path = if let Some(rest) = trimmed.strip_prefix('"') {
        rest.split_once('"').map(|(p, _)| p).unwrap_or("")
    } else {
        trimmed.split_whitespace().next().unwrap_or("")
    };

    !path.is_empty() && std::path::Path::new(path).exists()
}

#[cfg(windows)]
fn association_needs_repair(classes: &winreg::RegKey, current_prog_id: &str) -> bool {
    if current_prog_id.is_empty() {
        return true;
    }

    let command: String = classes
        .open_subkey(format!("{PROG_ID}\\shell\\open\\command"))
        .and_then(|k| k.get_value(""))
        .unwrap_or_default();

    !open_command_exe_exists(&command)
}

#[cfg(windows)]
pub fn ensure_smpr_association() {
    if cfg!(debug_assertions) {
        return;
    }

    use std::env;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
    use winreg::RegKey;

    let exe = match env::current_exe() {
        Ok(path) => path,
        Err(_) => return,
    };
    if !exe.exists() {
        return;
    }
    let exe_str = exe.to_string_lossy().replace('/', "\\");

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let classes = match hkcu.open_subkey_with_flags("Software\\Classes", KEY_READ | KEY_WRITE) {
        Ok(key) => key,
        Err(_) => return,
    };

    let current_prog_id: String = classes
        .open_subkey(".smpr")
        .and_then(|k| k.get_value(""))
        .unwrap_or_default();

    if !current_prog_id.is_empty() && current_prog_id != PROG_ID {
        return;
    }

    if !association_needs_repair(&classes, &current_prog_id) {
        return;
    }

    let _ = classes.create_subkey(".smpr").and_then(|(ext, _)| {
        ext.set_value("", &PROG_ID)?;
        Ok(())
    });

    let _ = classes.create_subkey(PROG_ID).and_then(|(prog, _)| {
        prog.set_value("", &"SanMoji subtitle project file")?;
        prog.create_subkey("DefaultIcon")?
            .0
            .set_value("", &format!("{exe_str},0"))?;
        prog.create_subkey("shell\\open\\command")?
            .0
            .set_value("", &format!("\"{exe_str}\" \"%1\""))?;
        Ok(())
    });
}

#[cfg(not(windows))]
pub fn ensure_smpr_association() {}