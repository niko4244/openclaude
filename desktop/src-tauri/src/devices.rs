//! Android devices and emulators, the Windows side of the reference app's device simulators:
//! list connected devices and virtual devices (AVDs), create and boot an emulator, and
//! approval-gated tools that let the model see and drive a device through adb.

use anyhow::{Context, Result, anyhow, bail};
use base64::Engine;
use serde::Serialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Clone, Debug, Serialize, Default)]
pub struct Sdk {
    pub adb: PathBuf,
    pub emulator: Option<PathBuf>,
    pub avdmanager: Option<PathBuf>,
    pub root: Option<PathBuf>,
}

fn exe(name: &str) -> String {
    if cfg!(windows) { format!("{name}.exe") } else { name.to_string() }
}

/// ANDROID_HOME / ANDROID_SDK_ROOT / the Android Studio default, then adb on PATH.
pub fn locate() -> Option<Sdk> {
    let mut roots: Vec<PathBuf> = ["ANDROID_HOME", "ANDROID_SDK_ROOT"].iter().filter_map(|v| std::env::var_os(v).map(PathBuf::from)).collect();
    if let Some(l) = dirs::data_local_dir() {
        roots.push(l.join("Android").join("Sdk"));
    }
    let root = roots.into_iter().find(|r| r.join("platform-tools").join(exe("adb")).is_file() || r.join("emulator").join(exe("emulator")).is_file());
    let adb = root
        .as_ref()
        .map(|r| r.join("platform-tools").join(exe("adb")))
        .filter(|p| p.is_file())
        .or_else(|| std::env::var_os("PATH").and_then(|p| std::env::split_paths(&p).map(|d| d.join(exe("adb"))).find(|p| p.is_file())))
        .or_else(|| dirs::home_dir().map(|h| h.join("tools").join("adb").join("platform-tools").join(exe("adb"))).filter(|p| p.is_file()))?;
    let emulator = root.as_ref().map(|r| r.join("emulator").join(exe("emulator"))).filter(|p| p.is_file());
    let avdmanager = root
        .as_ref()
        .map(|r| r.join("cmdline-tools").join("latest").join("bin").join(if cfg!(windows) { "avdmanager.bat" } else { "avdmanager" }))
        .filter(|p| p.is_file());
    Some(Sdk { adb, emulator, avdmanager, root })
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Device {
    pub serial: String,
    pub state: String,
    pub model: Option<String>,
    pub emulator: bool,
}

/// `adb devices -l` output.
pub fn parse_devices(out: &str) -> Vec<Device> {
    out.lines()
        .skip_while(|l| !l.starts_with("List of devices"))
        .skip(1)
        .filter_map(|l| {
            let mut parts = l.split_whitespace();
            let serial = parts.next()?.to_string();
            let state = parts.next()?.to_string();
            let model = l.split_whitespace().find_map(|p| p.strip_prefix("model:")).map(|m| m.replace('_', " "));
            Some(Device { emulator: serial.starts_with("emulator-"), serial, state, model })
        })
        .collect()
}

/// Installed system images as avdmanager package ids, e.g. `system-images;android-34;google_apis;x86_64`.
pub fn system_images(root: &Path) -> Vec<String> {
    let mut out = vec![];
    let dir = root.join("system-images");
    for api in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
        for tag in std::fs::read_dir(api.path()).into_iter().flatten().flatten() {
            for abi in std::fs::read_dir(tag.path()).into_iter().flatten().flatten() {
                if abi.path().join("system.img").is_file() || abi.path().join("source.properties").is_file() {
                    out.push(format!("system-images;{};{};{}", api.file_name().to_string_lossy(), tag.file_name().to_string_lossy(), abi.file_name().to_string_lossy()));
                }
            }
        }
    }
    out.sort();
    out
}

fn valid(s: &str, extra: &str) -> bool {
    !s.is_empty() && s.len() <= 200 && s.chars().all(|c| c.is_ascii_alphanumeric() || extra.contains(c))
}

async fn run(prog: &Path, args: &[&str], timeout: Duration) -> Result<Vec<u8>> {
    let mut c = tokio::process::Command::new(prog);
    c.args(args).stdin(std::process::Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let out = tokio::time::timeout(timeout, c.output()).await.map_err(|_| anyhow!("{} timed out", prog.display()))??;
    if !out.status.success() {
        bail!("{}", String::from_utf8_lossy(&out.stderr).trim().chars().take(300).collect::<String>());
    }
    Ok(out.stdout)
}

#[derive(Serialize, Default)]
pub struct Inventory {
    pub sdk: Option<Sdk>,
    pub devices: Vec<Device>,
    pub avds: Vec<String>,
    pub images: Vec<String>,
    /// Windows Hypervisor Platform, which the Android Emulator needs on Windows (None = unknown).
    pub hypervisor: Option<bool>,
}

/// Win32_OptionalFeature InstallState: 1 enabled, 2 disabled, 3 absent.
fn parse_install_state(out: &str) -> Option<bool> {
    match out.trim() {
        "1" => Some(true),
        "2" | "3" => Some(false),
        _ => None,
    }
}

/// Read-only check (no elevation, nothing changed).
#[cfg(windows)]
async fn hypervisor_platform() -> Option<bool> {
    let ps = Path::new(&std::env::var_os("SystemRoot")?).join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    let q = "(Get-CimInstance Win32_OptionalFeature -Filter \"Name='HypervisorPlatform'\").InstallState";
    let out = run(&ps, &["-NoProfile", "-NonInteractive", "-Command", q], Duration::from_secs(20)).await.ok()?;
    parse_install_state(&String::from_utf8_lossy(&out))
}

#[cfg(not(windows))]
async fn hypervisor_platform() -> Option<bool> {
    None
}

pub async fn inventory() -> Inventory {
    let hypervisor = hypervisor_platform().await;
    let Some(sdk) = locate() else { return Inventory { hypervisor, ..Default::default() } };
    let devices = run(&sdk.adb, &["devices", "-l"], Duration::from_secs(15)).await.map(|o| parse_devices(&String::from_utf8_lossy(&o))).unwrap_or_default();
    let avds = match &sdk.emulator {
        Some(e) => run(e, &["-list-avds"], Duration::from_secs(15)).await.map(|o| String::from_utf8_lossy(&o).lines().map(str::trim).filter(|l| valid(l, "._-")).map(str::to_string).collect()).unwrap_or_default(),
        None => vec![],
    };
    let images = sdk.root.as_deref().map(system_images).unwrap_or_default();
    Inventory { sdk: Some(sdk), devices, avds, images, hypervisor }
}

/// Starts an emulator; it keeps running after the app exits, like one started from Android Studio.
pub fn boot(sdk: &Sdk, avd: &str) -> Result<()> {
    if !valid(avd, "._-") {
        bail!("invalid virtual device name");
    }
    let e = sdk.emulator.as_ref().ok_or_else(|| anyhow!("The Android Emulator is not installed (Android Studio → SDK Manager → Android Emulator)"))?;
    let mut c = std::process::Command::new(e);
    c.args(["-avd", avd]).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000 | 0x0000_0008); // CREATE_NO_WINDOW | DETACHED_PROCESS
    }
    c.spawn().context("start the emulator")?;
    Ok(())
}

pub async fn create(sdk: &Sdk, name: &str, image: &str, device: &str) -> Result<()> {
    if !valid(name, "._-") || !valid(image, ";._-") || !valid(device, "._-") {
        bail!("invalid name, system image or device type");
    }
    let m = sdk.avdmanager.as_ref().ok_or_else(|| anyhow!("avdmanager not found (Android Studio → SDK Manager → Android SDK Command-line Tools)"))?;
    use tokio::io::AsyncWriteExt;
    let mut c = tokio::process::Command::new(m);
    c.args(["create", "avd", "-n", name, "-k", image, "-d", device]).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
    #[cfg(windows)]
    c.creation_flags(0x0800_0000);
    let mut child = c.spawn().context("start avdmanager")?;
    // "Do you wish to create a custom hardware profile? [no]"
    if let Some(mut i) = child.stdin.take() {
        let _ = i.write_all(b"no\n").await;
    }
    let out = tokio::time::timeout(Duration::from_secs(120), child.wait_with_output()).await.map_err(|_| anyhow!("avdmanager timed out"))??;
    if !out.status.success() {
        bail!("{}", String::from_utf8_lossy(&out.stderr).trim().chars().take(300).collect::<String>());
    }
    Ok(())
}

// ---------- model tools

pub fn tool_defs() -> Vec<Value> {
    let serial = json!({"type": "string", "description": "Device serial from device__list; optional when exactly one device is online"});
    let f = |name: &str, desc: &str, props: Value, req: &[&str]| json!({"type": "function", "function": {"name": name, "description": desc, "parameters": {"type": "object", "properties": props, "required": req}}});
    vec![
        f("device__list", "List connected Android devices and running emulators.", json!({}), &[]),
        f("device__screenshot", "Take a screenshot of an Android device or emulator.", json!({"serial": serial}), &[]),
        f("device__tap", "Tap the device screen at pixel coordinates of the latest device screenshot.", json!({"x": {"type": "integer"}, "y": {"type": "integer"}, "serial": serial}), &["x", "y"]),
        f("device__swipe", "Swipe on the device screen.", json!({"x1": {"type": "integer"}, "y1": {"type": "integer"}, "x2": {"type": "integer"}, "y2": {"type": "integer"}, "ms": {"type": "integer"}, "serial": serial}), &["x1", "y1", "x2", "y2"]),
        f("device__type", "Type text into the focused field on the device.", json!({"text": {"type": "string"}, "serial": serial}), &["text"]),
        f("device__key", "Press a device key: home, back, enter, delete, menu, app_switch, power, volume_up, volume_down, or an Android keycode number.", json!({"key": {"type": "string"}, "serial": serial}), &["key"]),
        f("device__launch", "Launch an installed app by package name (optionally a specific activity).", json!({"package": {"type": "string"}, "activity": {"type": "string"}, "serial": serial}), &["package"]),
    ]
}

/// `adb shell input text` takes one shell word: spaces become %s and shell metacharacters are escaped.
pub fn escape_text(t: &str) -> String {
    let mut out = String::new();
    for c in t.chars() {
        match c {
            ' ' => out.push_str("%s"),
            '\\' | '"' | '\'' | '`' | '$' | '&' | '|' | ';' | '<' | '>' | '(' | ')' | '*' | '~' | '#' | '!' | '?' | '[' | ']' | '{' | '}' | '%' => {
                out.push('\\');
                out.push(c);
            }
            '\n' | '\r' => {}
            c => out.push(c),
        }
    }
    out
}

pub fn keycode(key: &str) -> Option<u32> {
    let k = key.trim().to_ascii_lowercase();
    if let Ok(n) = k.parse::<u32>() {
        return (n < 400).then_some(n);
    }
    Some(match k.trim_start_matches("keycode_") {
        "home" => 3,
        "back" => 4,
        "enter" => 66,
        "delete" | "backspace" | "del" => 67,
        "menu" => 82,
        "app_switch" | "recents" => 187,
        "power" => 26,
        "volume_up" => 24,
        "volume_down" => 25,
        "tab" => 61,
        "escape" => 111,
        _ => return None,
    })
}

pub struct Output {
    pub text: String,
    pub image_data_url: Option<String>,
}

async fn pick_serial(sdk: &Sdk, args: &Value) -> Result<String> {
    if let Some(s) = args["serial"].as_str().filter(|s| !s.is_empty()) {
        if !valid(s, "._:-") {
            bail!("invalid serial");
        }
        return Ok(s.to_string());
    }
    let online: Vec<Device> = parse_devices(&String::from_utf8_lossy(&run(&sdk.adb, &["devices", "-l"], Duration::from_secs(15)).await?)).into_iter().filter(|d| d.state == "device").collect();
    match online.as_slice() {
        [one] => Ok(one.serial.clone()),
        [] => bail!("No Android device or emulator is online. Boot one in Settings → General → Android devices."),
        _ => bail!("Several devices are online; pass `serial` (see device__list)."),
    }
}

pub async fn execute(sdk: &Sdk, name: &str, args: &Value) -> Result<Output> {
    let text = |t: String| Output { text: t, image_data_url: None };
    if name == "device__list" {
        let d = parse_devices(&String::from_utf8_lossy(&run(&sdk.adb, &["devices", "-l"], Duration::from_secs(15)).await?));
        return Ok(text(if d.is_empty() { "No devices.".into() } else { serde_json::to_string_pretty(&d)? }));
    }
    let serial = pick_serial(sdk, args).await?;
    let adb = |extra: Vec<String>| {
        let mut a = vec!["-s".to_string(), serial.clone()];
        a.extend(extra);
        a
    };
    let shell = |cmd: Vec<String>| adb([vec!["shell".into()], cmd].concat());
    let num = |k: &str| args[k].as_i64().ok_or_else(|| anyhow!("`{k}` must be an integer"));
    let argv: Vec<String> = match name {
        "device__screenshot" => {
            let a = adb(vec!["exec-out".into(), "screencap".into(), "-p".into()]);
            let png = run(&sdk.adb, &a.iter().map(String::as_str).collect::<Vec<_>>(), Duration::from_secs(30)).await?;
            if !png.starts_with(b"\x89PNG") {
                bail!("the device did not return a PNG screenshot");
            }
            return Ok(Output { text: format!("screenshot of {serial}"), image_data_url: Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&png))) });
        }
        "device__tap" => shell(vec!["input".into(), "tap".into(), num("x")?.to_string(), num("y")?.to_string()]),
        "device__swipe" => shell(vec![
            "input".into(),
            "swipe".into(),
            num("x1")?.to_string(),
            num("y1")?.to_string(),
            num("x2")?.to_string(),
            num("y2")?.to_string(),
            args["ms"].as_i64().unwrap_or(300).clamp(50, 5000).to_string(),
        ]),
        "device__type" => shell(vec!["input".into(), "text".into(), escape_text(args["text"].as_str().unwrap_or_default())]),
        "device__key" => shell(vec!["input".into(), "keyevent".into(), keycode(args["key"].as_str().unwrap_or_default()).ok_or_else(|| anyhow!("unknown key"))?.to_string()]),
        "device__launch" => {
            let pkg = args["package"].as_str().unwrap_or_default();
            if !valid(pkg, "._") {
                bail!("invalid package name");
            }
            match args["activity"].as_str().filter(|a| !a.is_empty()) {
                Some(act) if valid(act, "._$") => shell(vec!["am".into(), "start".into(), "-n".into(), format!("{pkg}/{act}")]),
                Some(_) => bail!("invalid activity name"),
                None => shell(vec!["monkey".into(), "-p".into(), pkg.into(), "-c".into(), "android.intent.category.LAUNCHER".into(), "1".into()]),
            }
        }
        _ => bail!("unknown tool {name}"),
    };
    let out = run(&sdk.adb, &argv.iter().map(String::as_str).collect::<Vec<_>>(), Duration::from_secs(30)).await?;
    Ok(text(format!("done on {serial}{}", Some(String::from_utf8_lossy(&out).trim().to_string()).filter(|s| !s.is_empty()).map(|s| format!(": {}", s.chars().take(500).collect::<String>())).unwrap_or_default())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hypervisor_install_state() {
        assert_eq!(parse_install_state("1\r\n"), Some(true));
        assert_eq!(parse_install_state("2"), Some(false));
        assert_eq!(parse_install_state("3"), Some(false));
        assert_eq!(parse_install_state(""), None);
    }

    #[test]
    fn parses_adb_devices() {
        let out = "* daemon started successfully\nList of devices attached\nemulator-5554          device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64xa transport_id:1\nR58M12ABC              unauthorized usb:1-1 transport_id:2\n\n";
        let d = parse_devices(out);
        assert_eq!(d.len(), 2);
        assert_eq!(d[0], Device { serial: "emulator-5554".into(), state: "device".into(), model: Some("sdk gphone64 x86 64".into()), emulator: true });
        assert_eq!((d[1].state.as_str(), d[1].emulator, d[1].model.clone()), ("unauthorized", false, None));
        assert!(parse_devices("List of devices attached\n\n").is_empty());
    }

    #[test]
    fn text_and_keys_are_safe_for_adb_input() {
        assert_eq!(escape_text("hi there"), "hi%sthere");
        assert_eq!(escape_text("a;rm -rf $HOME"), "a\\;rm%s-rf%s\\$HOME");
        assert_eq!(escape_text("100% (ok)"), "100\\%%s\\(ok\\)");
        assert_eq!((keycode("home"), keycode("BACK"), keycode("KEYCODE_ENTER"), keycode("66"), keycode("9999"), keycode("rm")), (Some(3), Some(4), Some(66), Some(66), None, None));
    }

    #[test]
    fn finds_installed_system_images() {
        let t = tempfile::tempdir().unwrap();
        let p = t.path().join("system-images/android-34/google_apis/x86_64");
        std::fs::create_dir_all(&p).unwrap();
        std::fs::write(p.join("source.properties"), "x").unwrap();
        std::fs::create_dir_all(t.path().join("system-images/android-33/default/arm64-v8a")).unwrap();
        assert_eq!(system_images(t.path()), ["system-images;android-34;google_apis;x86_64"]);
    }

    /// The tools against a stub adb that records its arguments.
    #[cfg(windows)]
    #[tokio::test]
    async fn tools_build_the_right_adb_commands() {
        let t = tempfile::tempdir().unwrap();
        let log = t.path().join("args.txt");
        let stub = t.path().join("adb.cmd");
        std::fs::write(
            &stub,
            format!(
                "@echo off\r\n>>\"{}\" echo %*\r\nif \"%1\"==\"devices\" (echo List of devices attached& echo emulator-5554 device model:Pixel_7& exit /b 0)\r\nexit /b 0\r\n",
                log.display()
            ),
        )
        .unwrap();
        let sdk = Sdk { adb: stub, ..Default::default() };
        assert!(execute(&sdk, "device__list", &json!({})).await.unwrap().text.contains("emulator-5554"));
        execute(&sdk, "device__tap", &json!({"x": 10, "y": 20})).await.unwrap();
        execute(&sdk, "device__type", &json!({"text": "hello world"})).await.unwrap();
        execute(&sdk, "device__key", &json!({"key": "back", "serial": "emulator-5554"})).await.unwrap();
        execute(&sdk, "device__launch", &json!({"package": "com.android.settings"})).await.unwrap();
        assert!(execute(&sdk, "device__launch", &json!({"package": "x; reboot"})).await.is_err());
        assert!(execute(&sdk, "device__tap", &json!({"x": 1, "y": 2, "serial": "a b"})).await.is_err());
        // cmd.exe quotes arguments with `%` when calling a batch stub; the real adb.exe gets them as is.
        let calls = std::fs::read_to_string(&log).unwrap().replace('"', "");
        for want in ["-s emulator-5554 shell input tap 10 20", "-s emulator-5554 shell input text hello%sworld", "-s emulator-5554 shell input keyevent 4", "-s emulator-5554 shell monkey -p com.android.settings -c android.intent.category.LAUNCHER 1"] {
            assert!(calls.contains(want), "missing `{want}` in\n{calls}");
        }
    }
}
