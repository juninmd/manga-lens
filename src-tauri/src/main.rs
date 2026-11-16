#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod update;

use std::net::TcpListener;
use std::path::Path;
use std::sync::Mutex;

use tauri::{AppHandle, Manager, RunEvent, State};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

struct ApiPort(u16);
struct Sidecar(Mutex<Option<CommandChild>>);

/// Porta livre escolhida pelo SO: fixar 7788 quebraria se o usuario ja' rodar
/// a versao web ou outro app na mesma porta.
fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(7788)
}

#[tauri::command]
fn api_port(port: State<'_, ApiPort>) -> u16 {
    port.0
}

/// Abre o instalador que o sidecar baixou e conferiu, e fecha o app para o
/// instalador poder substituir os arquivos. O caminho vem do front, entao so' vale
/// um `MangaLens_X.Y.Z_x64-setup.exe` dentro da pasta de atualizacoes do app.
#[tauri::command]
fn install_update(app: AppHandle, path: String) -> Result<(), String> {
    // a mesma pasta que o sidecar usa (`CACHE_DIR/updates`, ver `setup`)
    let updates_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("cache")
        .join("updates");
    let installer = update::validate_installer(Path::new(&path), &updates_dir)?;
    update::launch_installer(&installer)?;

    // o instalador troca o executavel do app e o do sidecar: os dois tem de estar fechados
    if let Some(sidecar) = app.try_state::<Sidecar>() {
        if let Some(child) = sidecar.0.lock().ok().and_then(|mut c| c.take()) {
            let _ = child.kill();
        }
    }
    app.exit(0);
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![api_port, install_update])
        .setup(|app| {
            let port = free_port();
            app.manage(ApiPort(port));

            // cache (tessdata + respostas dos providers) vai para o diretorio do app,
            // nunca para o lado do executavel: em Program Files nao ha' escrita.
            let cache_dir = app
                .path()
                .app_cache_dir()
                .map(|p| p.join("cache"))
                .unwrap_or_else(|_| std::env::temp_dir().join("manga-lens-cache"));
            let _ = std::fs::create_dir_all(&cache_dir);

            let mut command = app
                .shell()
                .sidecar("manga-lens-server")?
                .env("PORT", port.to_string())
                // so' no app instalado o servidor oferece "atualizar agora" (no navegador nao ha' o que instalar)
                .env("MANGA_LENS_DESKTOP", "1")
                .env("CACHE_DIR", cache_dir.to_string_lossy().to_string())
                // se a janela morrer a seco, o sidecar percebe e se encerra sozinho
                .env("PARENT_PID", std::process::id().to_string());

            // Repassa a configuracao de IA e biblioteca local do ambiente do usuario.
            for key in [
                "AI_BASE_URL",
                "AI_API_KEY",
                "AI_MODEL",
                "AI_VISION_MODEL",
                "AI_MAX_TOKENS",
                "AI_TIMEOUT_MS",
                "LOCAL_LIBRARY",
                "MANGA_LENS_SECRET",
            ] {
                if let Ok(value) = std::env::var(key) {
                    command = command.env(key, value);
                }
            }

            let (_rx, child) = command.spawn()?;
            app.manage(Sidecar(Mutex::new(Some(child))));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("falha ao iniciar o MangaLens")
        .run(|app, event| {
            // sem isso o servidor fica orfao rodando depois que a janela fecha
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                if let Some(sidecar) = app.try_state::<Sidecar>() {
                    if let Some(child) = sidecar.0.lock().ok().and_then(|mut c| c.take()) {
                        let _ = child.kill();
                    }
                }
            }
        });
}
