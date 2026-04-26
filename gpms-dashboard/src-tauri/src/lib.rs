mod commands {
    use serde::Serialize;

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
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::execute_command,
            commands::get_system_info,
            commands::read_config
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
