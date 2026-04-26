mod commands {
    use serde::Serialize;

    fn chrono_lite_timestamp() -> u64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }

    #[tauri::command]
    pub fn execute_command(cmd: String) -> Result<String, String> {
        #[cfg(windows)]
        let output = std::process::Command::new("cmd")
            .args(["/C", &cmd])
            .output()
            .map_err(|e| e.to_string())?;
        #[cfg(not(windows))]
        let output = std::process::Command::new("sh")
            .arg("-c")
            .arg(&cmd)
            .output()
            .map_err(|e| e.to_string())?;
        let mut s = String::new();
        if !output.stdout.is_empty() {
            s.push_str(&String::from_utf8_lossy(&output.stdout));
        }
        if !output.stderr.is_empty() {
            if !s.is_empty() {
                s.push('\n');
            }
            s.push_str(&String::from_utf8_lossy(&output.stderr));
        }
        if !output.status.success() {
            return if s.is_empty() {
                Err("command failed (no output)".into())
            } else {
                Err(s)
            };
        }
        Ok(s)
    }

    #[derive(Serialize, Clone, Debug)]
    pub struct SystemInfo {
        pub hostname: String,
        pub kernel: String,
        pub cpu: String,
        pub total_ram_mb: u64,
    }

    #[tauri::command]
    pub fn get_system_info() -> Result<SystemInfo, String> {
        let hostname = std::fs::read_to_string("/etc/hostname")
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|_| "unknown".into());
        let kernel = std::fs::read_to_string("/proc/sys/kernel/osrelease")
            .ok()
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|| "unknown".into());

        let mut sys = sysinfo::System::new();
        sys.refresh_cpu_list(sysinfo::CpuRefreshKind::everything());
        sys.refresh_memory();
        let cpu = sys
            .cpus()
            .first()
            .map(|c| c.brand().trim().to_string())
            .filter(|b| !b.is_empty())
            .unwrap_or_else(|| "unknown".into());
        let total_ram_mb = sys.total_memory() / 1024 / 1024;
        Ok(SystemInfo {
            hostname,
            kernel,
            cpu,
            total_ram_mb,
        })
    }

    #[tauri::command]
    pub fn read_config(path: String) -> Result<String, String> {
        std::fs::read_to_string(&path).map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn script_start() -> Result<String, String> {
        let output = std::process::Command::new("bash")
            .arg("/home/oem/git/bearhack/start.sh")
            .output()
            .map_err(|e| e.to_string())?;
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }

    #[tauri::command]
    pub fn script_watch() -> Result<String, String> {
        let output = std::process::Command::new("bash")
            .arg("/home/oem/git/bearhack/watch.sh")
            .output()
            .map_err(|e| e.to_string())?;
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }

    #[tauri::command]
    pub fn script_suspend() -> Result<String, String> {
        let output = std::process::Command::new("bash")
            .arg("/home/oem/git/bearhack/suspend.sh")
            .output()
            .map_err(|e| e.to_string())?;
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }

    #[tauri::command]
    pub fn script_resume() -> Result<String, String> {
        let output = std::process::Command::new("bash")
            .arg("/home/oem/git/bearhack/resume.sh")
            .output()
            .map_err(|e| e.to_string())?;
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }

    #[tauri::command]
    pub fn croc_send(pid: String, migration_id: Option<String>) -> Result<String, String> {
        let id_arg = migration_id.unwrap_or_else(|| format!("mig-{}", chrono_lite_timestamp()));
        let output = std::process::Command::new("bash")
            .arg("/home/oem/git/bearhack/gpms-croc-migrate.sh")
            .arg("send")
            .arg(&pid)
            .arg(&id_arg)
            .output()
            .map_err(|e| e.to_string())?;
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }

    #[tauri::command]
    pub fn croc_receive(migration_id: Option<String>) -> Result<String, String> {
        let output = std::process::Command::new("bash")
            .arg("/home/oem/git/bearhack/gpms-croc-migrate.sh")
            .arg("receive")
            .arg(migration_id.unwrap_or_default())
            .output()
            .map_err(|e| e.to_string())?;
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }

    #[tauri::command]
    pub fn croc_send_running(pid: String, migration_id: Option<String>) -> Result<String, String> {
        let id_arg = migration_id.unwrap_or_else(|| format!("mig-{}", chrono_lite_timestamp()));
        let output = std::process::Command::new("bash")
            .arg("/home/oem/git/bearhack/gpms-croc-migrate.sh")
            .arg("send-running")
            .arg(&pid)
            .arg(&id_arg)
            .output()
            .map_err(|e| e.to_string())?;
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::execute_command,
            commands::get_system_info,
            commands::read_config,
            commands::script_start,
            commands::script_watch,
            commands::script_suspend,
            commands::script_resume,
            commands::croc_send,
            commands::croc_receive,
            commands::croc_send_running
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
