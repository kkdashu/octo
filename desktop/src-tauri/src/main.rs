#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;
use std::error::Error;
use std::io;
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use url::Url;

const SIDECAR_HOST: &str = "127.0.0.1";
const UI_DEV_URL: &str = "http://127.0.0.1:1420";
const SIDECAR_START_TIMEOUT: Duration = Duration::from_secs(15);

struct DesktopState {
    sidecar: Mutex<Option<Child>>,
}

fn resolve_repo_root() -> PathBuf {
    if let Ok(root_dir) = env::var("OCTO_DESKTOP_ROOT_DIR") {
        return PathBuf::from(root_dir);
    }

    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
}

fn choose_available_port() -> Result<u16, Box<dyn Error>> {
    let listener = TcpListener::bind((SIDECAR_HOST, 0))?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

fn wait_for_sidecar(address: &str) -> Result<(), Box<dyn Error>> {
    let deadline = Instant::now() + SIDECAR_START_TIMEOUT;

    loop {
        match TcpStream::connect(address) {
            Ok(stream) => {
                let _ = stream.shutdown(Shutdown::Both);
                return Ok(());
            }
            Err(error) => {
                if Instant::now() >= deadline {
                    return Err(Box::new(io::Error::new(
                        io::ErrorKind::TimedOut,
                        format!("Desktop sidecar did not become ready on {address}: {error}"),
                    )));
                }
            }
        }

        thread::sleep(Duration::from_millis(150));
    }
}

fn start_sidecar(repo_root: &Path) -> Result<(Child, String), Box<dyn Error>> {
    let port = choose_available_port()?;
    let base_url = format!("http://{SIDECAR_HOST}:{port}");
    let address = format!("{SIDECAR_HOST}:{port}");

    let mut command = Command::new("bun");
    command
        .arg("run")
        .arg("desktop:sidecar")
        .current_dir(repo_root)
        .env("OCTO_ROOT_DIR", repo_root)
        .env("DESKTOP_HOSTNAME", SIDECAR_HOST)
        .env("DESKTOP_PORT", port.to_string())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    let mut child = command.spawn().map_err(|error| {
        io::Error::new(
            io::ErrorKind::NotFound,
            format!("Failed to start desktop sidecar via bun: {error}"),
        )
    })?;

    if let Err(error) = wait_for_sidecar(&address) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }

    Ok((child, base_url))
}

fn create_main_window(
    app: &tauri::AppHandle,
    sidecar_base_url: &str,
) -> Result<(), Box<dyn Error>> {
    let webview_url = if cfg!(debug_assertions) {
        WebviewUrl::External(Url::parse(UI_DEV_URL)?)
    } else {
        WebviewUrl::App("index.html".into())
    };

    let initialization_script = format!(
        "window.__OCTO_DESKTOP_CONFIG__ = {{ sidecarBaseUrl: {:?}, platform: 'tauri' }};",
        sidecar_base_url,
    );

    WebviewWindowBuilder::new(app, "main", webview_url)
        .title("Octo Desktop")
        .inner_size(1440.0, 920.0)
        .min_inner_size(1080.0, 720.0)
        .initialization_script(&initialization_script)
        .build()?;

    Ok(())
}

fn stop_sidecar(app: &tauri::AppHandle) {
    let state = app.state::<DesktopState>();
    let mut sidecar = state.sidecar.lock().unwrap();
    if let Some(mut child) = sidecar.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let repo_root = resolve_repo_root();
            let (sidecar, sidecar_base_url) = start_sidecar(&repo_root)?;
            app.manage(DesktopState {
                sidecar: Mutex::new(Some(sidecar)),
            });
            create_main_window(app.handle(), &sidecar_base_url)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Octo desktop app")
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                stop_sidecar(app);
            }
        });
}
