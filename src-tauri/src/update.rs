//! Instalacao da atualizacao baixada pelo sidecar (`src/server/updater.ts`).
//!
//! O servidor baixa e confere o hash; quem ABRE o instalador e' este modulo, e ele
//! nao confia no caminho que recebe do front: so' roda um `MangaLens_X.Y.Z_x64-setup.exe`
//! que esteja DENTRO da pasta de atualizacoes do app. Sem isso, qualquer script na
//! janela poderia pedir para executar um programa arbitrario.
//!
//! So' usa `std`: compila e testa sem o Tauri (`rustc --test src/update.rs`).

use std::path::{Path, PathBuf};

/// Mesmos argumentos que o atualizador oficial do Tauri passa ao NSIS:
/// `/P` janela com barra de progresso (sem perguntas), `/UPDATE` modo atualizacao
/// e `/R` reabre o app quando termina.
pub const INSTALLER_ARGS: [&str; 3] = ["/P", "/UPDATE", "/R"];

/// `MangaLens_<major>.<minor>.<patch>_x64-setup.exe`, e so' isso.
pub fn is_installer_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("MangaLens_") else {
        return false;
    };
    let Some(version) = rest.strip_suffix("_x64-setup.exe") else {
        return false;
    };
    let parts: Vec<&str> = version.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.len() <= 6 && p.bytes().all(|b| b.is_ascii_digit()))
}

/// Confere que `path` e' um instalador legitimo dentro de `updates_dir` e devolve o
/// caminho canonico (sem `..`, sem link simbolico apontando para fora).
pub fn validate_installer(path: &Path, updates_dir: &Path) -> Result<PathBuf, String> {
    let dir = std::fs::canonicalize(updates_dir)
        .map_err(|e| format!("a pasta de atualizacoes nao existe: {e}"))?;
    let file = std::fs::canonicalize(path).map_err(|e| format!("instalador nao encontrado: {e}"))?;
    if file.parent() != Some(dir.as_path()) {
        return Err("o instalador esta fora da pasta de atualizacoes".into());
    }
    let name = file.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if !is_installer_name(name) {
        return Err(format!("\"{name}\" nao e um instalador do MangaLens"));
    }
    if !file.is_file() {
        return Err("o instalador nao e um arquivo".into());
    }
    Ok(file)
}

/// `canonicalize` no Windows devolve `\\?\C:\...`; o resto do sistema (e o NSIS)
/// espera o caminho comum. Caminho de rede (`\\?\UNC\...`) fica como esta'.
pub fn strip_verbatim(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        let b = rest.as_bytes();
        if b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'\\' {
            return PathBuf::from(rest);
        }
    }
    path.to_path_buf()
}

/// Abre o instalador sem esperar por ele: o app fecha logo depois, e o instalador
/// precisa sobreviver a isso.
#[cfg(windows)]
pub fn launch_installer(installer: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    const FLAGS: u32 = 0x0000_0008 | 0x0000_0200;
    std::process::Command::new(strip_verbatim(installer))
        .args(INSTALLER_ARGS)
        .creation_flags(FLAGS)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("nao consegui abrir o instalador: {e}"))
}

#[cfg(not(windows))]
pub fn launch_installer(_installer: &Path) -> Result<(), String> {
    Err("a instalacao automatica so existe no Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Pasta temporaria unica, sem dependencia externa.
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ml-update-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn so_o_nome_do_instalador_passa() {
        assert!(is_installer_name("MangaLens_0.9.0_x64-setup.exe"));
        assert!(is_installer_name("MangaLens_12.340.5_x64-setup.exe"));
        for bad in [
            "MangaLens_0.9.0_x64-setup.exe.bat",
            "MangaLens_0.9_x64-setup.exe",
            "MangaLens_0.9.0.1_x64-setup.exe",
            "MangaLens_a.b.c_x64-setup.exe",
            "MangaLens_0.9.0_x86-setup.exe",
            "MangaLens_..\\..\\x_x64-setup.exe",
            "MangaLens__.._x64-setup.exe",
            "malware.exe",
            "cmd.exe",
            "",
            "MangaLens_1234567.0.0_x64-setup.exe",
        ] {
            assert!(!is_installer_name(bad), "{bad} nao devia passar");
        }
    }

    #[test]
    fn aceita_o_instalador_dentro_da_pasta() {
        let dir = scratch("ok");
        let file = dir.join("MangaLens_0.9.0_x64-setup.exe");
        fs::write(&file, b"MZ").unwrap();
        let ok = validate_installer(&file, &dir).unwrap();
        assert_eq!(ok.file_name().unwrap(), "MangaLens_0.9.0_x64-setup.exe");
        assert_eq!(ok.parent().unwrap(), fs::canonicalize(&dir).unwrap());
    }

    #[test]
    fn recusa_arquivo_fora_da_pasta_ou_com_nome_errado() {
        let dir = scratch("fora");
        let other = scratch("fora-outro");
        let outside = other.join("MangaLens_0.9.0_x64-setup.exe");
        fs::write(&outside, b"MZ").unwrap();
        assert!(validate_installer(&outside, &dir).unwrap_err().contains("fora da pasta"));

        let wrong = dir.join("evil.exe");
        fs::write(&wrong, b"MZ").unwrap();
        assert!(validate_installer(&wrong, &dir).unwrap_err().contains("nao e um instalador"));

        assert!(validate_installer(&dir.join("MangaLens_9.9.9_x64-setup.exe"), &dir)
            .unwrap_err()
            .contains("nao encontrado"));
        assert!(validate_installer(&wrong, &dir.join("nao-existe"))
            .unwrap_err()
            .contains("nao existe"));
    }

    #[test]
    fn recusa_travessia_com_ponto_ponto() {
        let dir = scratch("trav");
        let sub = dir.join("sub");
        fs::create_dir_all(&sub).unwrap();
        let file = sub.join("MangaLens_0.9.0_x64-setup.exe");
        fs::write(&file, b"MZ").unwrap();
        // `updates/sub/../sub/x.exe` resolve para `updates/sub/x.exe`: dentro de `sub`, nao da pasta
        let sneaky = dir.join("sub").join("..").join("sub").join("MangaLens_0.9.0_x64-setup.exe");
        assert!(validate_installer(&sneaky, &dir).unwrap_err().contains("fora da pasta"));
    }

    #[cfg(unix)]
    #[test]
    fn recusa_link_simbolico_para_fora() {
        let dir = scratch("link");
        let other = scratch("link-alvo");
        let real = other.join("MangaLens_0.9.0_x64-setup.exe");
        fs::write(&real, b"MZ").unwrap();
        let link = dir.join("MangaLens_0.9.0_x64-setup.exe");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(validate_installer(&link, &dir).unwrap_err().contains("fora da pasta"));
    }

    #[test]
    fn tira_o_prefixo_verbatim_so_de_caminho_com_letra_de_unidade() {
        assert_eq!(strip_verbatim(Path::new(r"\\?\C:\Users\a\x.exe")), PathBuf::from(r"C:\Users\a\x.exe"));
        assert_eq!(strip_verbatim(Path::new(r"\\?\UNC\srv\share\x.exe")), PathBuf::from(r"\\?\UNC\srv\share\x.exe"));
        assert_eq!(strip_verbatim(Path::new(r"C:\x.exe")), PathBuf::from(r"C:\x.exe"));
        assert_eq!(strip_verbatim(Path::new("/tmp/x.exe")), PathBuf::from("/tmp/x.exe"));
    }

    #[test]
    fn argumentos_sao_os_do_atualizador_oficial() {
        assert_eq!(INSTALLER_ARGS, ["/P", "/UPDATE", "/R"]);
    }

    #[cfg(not(windows))]
    #[test]
    fn fora_do_windows_nao_executa_nada() {
        assert!(launch_installer(Path::new("/bin/true")).unwrap_err().contains("so existe no Windows"));
    }
}
