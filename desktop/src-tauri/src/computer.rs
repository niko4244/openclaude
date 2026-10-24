//! Computer use: screenshot the primary monitor and drive mouse/keyboard.
//! Coordinates arrive in screenshot pixel space and are mapped back to the
//! input backend's screen space at action time. Nothing acts before a first
//! screenshot, so every coordinate is grounded in something the model saw.

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use serde_json::{json, Value};
use std::sync::Mutex;
use xcap::image::{imageops, DynamicImage, ImageFormat, RgbaImage};

const MAX_SIDE: u32 = 1366;
const MAX_TEXT: usize = 2000;
const SETTLE_MS: u64 = 400;

pub struct Output {
    pub text: String,
    pub image_data_url: Option<String>,
}

/// Size of the last screenshot sent to the model (scaled space).
#[derive(Clone, Copy, Debug, PartialEq)]
struct Shot {
    w: u32,
    h: u32,
}

static LAST: Mutex<Option<Shot>> = Mutex::new(None);

fn tool(name: &str, desc: &str, props: Value, required: &[&str]) -> Value {
    json!({"type": "function", "function": {
        "name": name, "description": desc,
        "parameters": {"type": "object", "properties": props,
                       "required": required, "additionalProperties": false}}})
}

pub fn tool_defs() -> Vec<Value> {
    let xy = |what: &str| {
        json!({"type": "integer", "minimum": 0,
               "description": format!("{what} in pixels of the most recent screenshot")})
    };
    vec![
        tool("computer__screenshot",
             "Capture the primary screen. Call this first; all coordinates refer to the latest screenshot.",
             json!({}), &[]),
        tool("computer__click", "Move to (x, y) and click. Returns a fresh screenshot.",
             json!({"x": xy("X"), "y": xy("Y"),
                    "button": {"type": "string", "enum": ["left", "right", "middle"]},
                    "double": {"type": "boolean", "description": "double-click"}}),
             &["x", "y"]),
        tool("computer__type", "Type text at the current focus. Returns a fresh screenshot.",
             json!({"text": {"type": "string", "maxLength": MAX_TEXT}}), &["text"]),
        tool("computer__key",
             "Press a key or combo, e.g. \"enter\", \"ctrl+s\", \"ctrl+shift+t\", \"f5\". Returns a fresh screenshot.",
             json!({"combo": {"type": "string"}}), &["combo"]),
        tool("computer__scroll", "Scroll at (x, y). Returns a fresh screenshot.",
             json!({"x": xy("X"), "y": xy("Y"),
                    "direction": {"type": "string", "enum": ["up", "down", "left", "right"]},
                    "amount": {"type": "integer", "minimum": 1, "maximum": 20}}),
             &["x", "y", "direction"]),
        tool("computer__move", "Move the mouse to (x, y) without clicking.",
             json!({"x": xy("X"), "y": xy("Y")}), &["x", "y"]),
    ]
}

/// Canonical key name for a combo token, or None if unknown.
fn canon(tok: &str) -> Option<String> {
    let t = tok.trim().to_lowercase();
    let c = match t.as_str() {
        "ctrl" | "control" => "ctrl",
        "alt" | "option" => "alt",
        "shift" => "shift",
        "win" | "windows" | "meta" | "super" | "cmd" | "command" => "win",
        "enter" | "return" => "enter",
        "esc" | "escape" => "esc",
        "del" | "delete" => "delete",
        "backspace" | "tab" | "space" | "insert" | "home" | "end" | "up" | "down" | "left"
        | "right" => t.as_str(),
        "pageup" | "pgup" => "pageup",
        "pagedown" | "pgdn" => "pagedown",
        _ => {
            if let Some(n) = t.strip_prefix('f').and_then(|n| n.parse::<u8>().ok()) {
                return (1..=24).contains(&n).then(|| t.clone());
            }
            let mut cs = t.chars();
            return match (cs.next(), cs.next()) {
                (Some(ch), None) if ch.is_ascii_graphic() => Some(t.clone()),
                _ => None,
            };
        }
    };
    Some(c.to_string())
}

const F_KEYS: [Key; 24] = [
    Key::F1, Key::F2, Key::F3, Key::F4, Key::F5, Key::F6, Key::F7, Key::F8, Key::F9, Key::F10,
    Key::F11, Key::F12, Key::F13, Key::F14, Key::F15, Key::F16, Key::F17, Key::F18, Key::F19,
    Key::F20, Key::F21, Key::F22, Key::F23, Key::F24,
];

fn to_key(c: &str) -> Key {
    match c {
        "ctrl" => Key::Control,
        "alt" => Key::Alt,
        "shift" => Key::Shift,
        "win" => Key::Meta,
        "enter" => Key::Return,
        "esc" => Key::Escape,
        "delete" => Key::Delete,
        "backspace" => Key::Backspace,
        "tab" => Key::Tab,
        "space" => Key::Space,
        "insert" => Key::Insert,
        "home" => Key::Home,
        "end" => Key::End,
        "up" => Key::UpArrow,
        "down" => Key::DownArrow,
        "left" => Key::LeftArrow,
        "right" => Key::RightArrow,
        "pageup" => Key::PageUp,
        "pagedown" => Key::PageDown,
        f if f.len() > 1 && f.starts_with('f') => F_KEYS[f[1..].parse::<usize>().unwrap() - 1],
        ch => Key::Unicode(ch.chars().next().unwrap()),
    }
}

/// Combos that lock, log off, or hijack the session. Matched as sets.
const DENIED: &[&[&str]] = &[&["win", "l"], &["ctrl", "alt", "delete"], &["ctrl", "alt", "end"]];

/// Parse "ctrl+shift+t" into keys: modifiers first, last key is the one tapped.
pub fn parse_combo(s: &str) -> Result<Vec<Key>> {
    let names = s
        .split('+')
        .map(|t| canon(t).ok_or_else(|| anyhow!("unknown key {t:?} in {s:?}")))
        .collect::<Result<Vec<_>>>()?;
    if names.is_empty() || names.len() > 4 {
        bail!("combo must have 1-4 keys: {s:?}");
    }
    for d in DENIED {
        if names.len() == d.len() && d.iter().all(|k| names.iter().any(|n| n == k)) {
            bail!("refused: {s:?} locks or interrupts the session");
        }
    }
    Ok(names.iter().map(|n| to_key(n)).collect())
}

/// Screenshot pixel -> backend pixel (pixel centre, clamped). `disp` is the
/// backend's screen extent on that axis, `shot` the screenshot's.
fn to_screen(v: u32, shot: u32, disp: u32) -> i32 {
    let p = (2 * v as u64 + 1) * disp as u64 / (2 * shot as u64);
    p.min(disp as u64 - 1) as i32
}

/// Longest side clamped to `max`, aspect kept.
fn scaled_dims(w: u32, h: u32, max: u32) -> (u32, u32) {
    let long = w.max(h);
    if long <= max {
        return (w, h);
    }
    let f = |v: u32| ((v as u64 * max as u64 + long as u64 / 2) / long as u64).max(1) as u32;
    (f(w), f(h))
}

#[derive(Debug, PartialEq)]
enum Action {
    Screenshot,
    Click { x: u32, y: u32, button: &'static str, double: bool },
    Type(String),
    Key(String),
    Scroll { x: u32, y: u32, dir: &'static str, amount: i32 },
    Move { x: u32, y: u32 },
}

fn coord(args: &Value, k: &str, max: u32) -> Result<u32> {
    let v = args.get(k).and_then(Value::as_f64).ok_or_else(|| anyhow!("missing number `{k}`"))?;
    if !v.is_finite() || v < 0.0 || v >= max as f64 {
        bail!("`{k}`={v} is outside the screenshot (0..{max})");
    }
    Ok(v as u32)
}

/// One of `opts`; `default` when absent (None = required).
fn pick(args: &Value, k: &str, opts: &[&'static str], default: Option<&'static str>) -> Result<&'static str> {
    match args.get(k) {
        None | Some(Value::Null) => default.ok_or_else(|| anyhow!("missing `{k}`")),
        Some(v) => {
            let s = v.as_str().unwrap_or("");
            opts.iter().copied().find(|o| *o == s).ok_or_else(|| anyhow!("`{k}` must be one of {opts:?}"))
        }
    }
}

/// Validate args against the last screenshot. Pure: no I/O.
fn validate(name: &str, args: &Value, last: Option<Shot>) -> Result<Action> {
    if name == "computer__screenshot" {
        return Ok(Action::Screenshot);
    }
    if !name.starts_with("computer__") || !tool_defs().iter().any(|t| t["function"]["name"] == name) {
        bail!("unknown computer tool {name}");
    }
    let s = last.ok_or_else(|| anyhow!("take computer__screenshot first"))?;
    Ok(match name {
        "computer__click" => Action::Click {
            x: coord(args, "x", s.w)?,
            y: coord(args, "y", s.h)?,
            button: pick(args, "button", &["left", "right", "middle"], Some("left"))?,
            double: args.get("double").and_then(Value::as_bool).unwrap_or(false),
        },
        "computer__type" => {
            let t = args.get("text").and_then(Value::as_str).ok_or_else(|| anyhow!("missing `text`"))?;
            if t.is_empty() || t.chars().count() > MAX_TEXT {
                bail!("`text` must be 1-{MAX_TEXT} chars");
            }
            Action::Type(t.to_string())
        }
        "computer__key" => {
            let c = args.get("combo").and_then(Value::as_str).ok_or_else(|| anyhow!("missing `combo`"))?;
            parse_combo(c)?;
            Action::Key(c.to_string())
        }
        "computer__scroll" => {
            let amount = args.get("amount").and_then(Value::as_i64).unwrap_or(3);
            if !(1..=20).contains(&amount) {
                bail!("`amount` must be 1-20");
            }
            Action::Scroll {
                x: coord(args, "x", s.w)?,
                y: coord(args, "y", s.h)?,
                dir: pick(args, "direction", &["up", "down", "left", "right"], None)?,
                amount: amount as i32,
            }
        }
        _ => Action::Move { x: coord(args, "x", s.w)?, y: coord(args, "y", s.h)? },
    })
}

/// The primary monitor with its longest side at most `max_side`, plus its physical size.
pub(crate) fn grab(max_side: u32) -> Result<(RgbaImage, u32, u32)> {
    let mon = xcap::Monitor::all()?
        .into_iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .context("no primary monitor")?;
    let img = mon.capture_image()?;
    let (pw, ph) = img.dimensions();
    Ok((fit(img, max_side), pw, ph))
}

/// Downscale so the longest side is at most `max_side`.
pub(crate) fn fit(img: RgbaImage, max_side: u32) -> RgbaImage {
    let (pw, ph) = img.dimensions();
    let (w, h) = scaled_dims(pw, ph, max_side);
    if (w, h) == (pw, ph) { img } else { imageops::resize(&img, w, h, imageops::FilterType::Triangle) }
}

pub(crate) fn png(img: RgbaImage) -> Result<Vec<u8>> {
    let mut png = Vec::new();
    DynamicImage::ImageRgba8(img)
        .to_rgb8()
        .write_to(&mut std::io::Cursor::new(&mut png), ImageFormat::Png)?;
    Ok(png)
}

fn capture() -> Result<Output> {
    let (img, pw, ph) = grab(MAX_SIDE)?;
    let (w, h) = img.dimensions();
    let png = png(img)?;
    *LAST.lock().unwrap() = Some(Shot { w, h });
    Ok(Output {
        text: format!("screenshot {w}x{h} (scaled from {pw}x{ph})"),
        image_data_url: Some(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&png)
        )),
    })
}

fn perform(a: &Action, s: Shot) -> Result<String> {
    let mut e = Enigo::new(&Settings::default()).map_err(|e| anyhow!("input backend: {e}"))?;
    let (dw, dh) = e.main_display().map_err(|e| anyhow!("{e}"))?;
    let goto = |e: &mut Enigo, x: u32, y: u32| -> Result<()> {
        let (sx, sy) = (to_screen(x, s.w, dw as u32), to_screen(y, s.h, dh as u32));
        e.move_mouse(sx, sy, Coordinate::Abs).map_err(|e| anyhow!("{e}"))
    };
    Ok(match a {
        Action::Click { x, y, button, double } => {
            goto(&mut e, *x, *y)?;
            let b = match *button { "right" => Button::Right, "middle" => Button::Middle, _ => Button::Left };
            for _ in 0..if *double { 2 } else { 1 } {
                e.button(b, Direction::Click).map_err(|e| anyhow!("{e}"))?;
            }
            format!("{}{button} click at ({x}, {y})", if *double { "double " } else { "" })
        }
        Action::Type(t) => {
            e.text(t).map_err(|e| anyhow!("{e}"))?;
            format!("typed {} chars", t.chars().count())
        }
        Action::Key(c) => {
            let keys = parse_combo(c)?;
            let (last, mods) = keys.split_last().unwrap();
            let mut res = Ok(());
            let mut held = vec![];
            for m in mods {
                res = e.key(*m, Direction::Press);
                if res.is_err() { break; }
                held.push(*m);
            }
            if res.is_ok() {
                res = e.key(*last, Direction::Click);
            }
            for m in held.iter().rev() {
                let _ = e.key(*m, Direction::Release); // always release what we pressed
            }
            res.map_err(|e| anyhow!("{e}"))?;
            format!("pressed {c}")
        }
        Action::Scroll { x, y, dir, amount } => {
            goto(&mut e, *x, *y)?;
            // enigo: positive = down / right.
            let (len, axis) = match *dir {
                "up" => (-amount, Axis::Vertical),
                "down" => (*amount, Axis::Vertical),
                "left" => (-amount, Axis::Horizontal),
                _ => (*amount, Axis::Horizontal),
            };
            e.scroll(len, axis).map_err(|e| anyhow!("{e}"))?;
            format!("scrolled {dir} {amount} at ({x}, {y})")
        }
        Action::Move { x, y } => {
            goto(&mut e, *x, *y)?;
            format!("moved to ({x}, {y})")
        }
        Action::Screenshot => unreachable!(),
    })
}

pub async fn execute(name: &str, args: &Value) -> Result<Output> {
    let last = *LAST.lock().unwrap();
    let action = validate(name, args, last)?;
    if action == Action::Screenshot {
        return tokio::task::spawn_blocking(capture).await?;
    }
    let shot = last.unwrap();
    let observe = !matches!(action, Action::Move { .. });
    tokio::task::spawn_blocking(move || {
        let did = perform(&action, shot)?;
        if !observe {
            return Ok(Output { text: did, image_data_url: None });
        }
        std::thread::sleep(std::time::Duration::from_millis(SETTLE_MS));
        let mut out = capture()?;
        out.text = format!("{did}; {}", out.text);
        Ok(out)
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computer_tool_defs_are_well_formed_and_unique() {
        let defs = tool_defs();
        let mut names: Vec<&str> = defs.iter().map(|d| d["function"]["name"].as_str().unwrap()).collect();
        assert_eq!(names.len(), 6);
        names.sort();
        names.dedup();
        assert_eq!(names.len(), 6);
        for d in &defs {
            assert_eq!(d["type"], "function");
            let p = &d["function"]["parameters"];
            assert_eq!(p["type"], "object");
            for r in p["required"].as_array().unwrap() {
                assert!(p["properties"].get(r.as_str().unwrap()).is_some(), "{d}");
            }
        }
    }

    #[test]
    fn computer_parse_combo_accepts_common_keys() {
        let k = parse_combo("ctrl+shift+t").unwrap();
        assert_eq!(k.len(), 3);
        assert!(matches!(k[0], Key::Control) && matches!(k[1], Key::Shift) && matches!(k[2], Key::Unicode('t')));
        assert!(matches!(parse_combo("enter").unwrap()[..], [Key::Return]));
        assert!(matches!(parse_combo("F5").unwrap()[..], [Key::F5]));
        assert!(matches!(parse_combo("alt+f4").unwrap()[..], [Key::Alt, Key::F4]));
        assert!(matches!(parse_combo("ctrl+s").unwrap()[..], [Key::Control, Key::Unicode('s')]));
    }

    #[test]
    fn computer_parse_combo_rejects_lock_and_gibberish() {
        for bad in ["win+l", "L+Win", "meta+l", "ctrl+alt+delete", "alt+ctrl+del", "ctrl+alt+end",
                    "gibberish", "ctrl+", "", "f25", "ctrl+alt+shift+win+x"] {
            assert!(parse_combo(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn computer_coordinate_mapping_round_trips() {
        for (shot, disp) in [(1366u32, 2560u32), (1366, 1440), (1366, 1366), (768, 1440), (1000, 3840)] {
            for v in 0..shot {
                let p = to_screen(v, shot, disp) as u64;
                assert!(p < disp as u64);
                // inverse: backend pixel -> screenshot pixel
                let back = ((2 * p + 1) * shot as u64 / (2 * disp as u64)) as u32;
                assert_eq!(back, v, "shot={shot} disp={disp}");
            }
        }
        // backend smaller than screenshot (DPI-virtualised): still in bounds.
        assert!((0..1366).all(|v| (to_screen(v, 1366, 1280) as u32) < 1280));
        assert_eq!(scaled_dims(2560, 1440, MAX_SIDE), (1366, 768));
        assert_eq!(scaled_dims(1440, 2560, MAX_SIDE), (768, 1366));
        assert_eq!(scaled_dims(1280, 720, MAX_SIDE), (1280, 720));
    }

    #[test]
    fn computer_validate_requires_screenshot_and_bounds() {
        let a = json!({"x": 10, "y": 10});
        assert!(validate("computer__click", &a, None).is_err());
        let s = Some(Shot { w: 100, h: 50 });
        assert_eq!(
            validate("computer__click", &a, s).unwrap(),
            Action::Click { x: 10, y: 10, button: "left", double: false }
        );
        assert!(validate("computer__click", &json!({"x": 100, "y": 0}), s).is_err());
        assert!(validate("computer__click", &json!({"x": -1, "y": 0}), s).is_err());
        assert!(validate("computer__click", &json!({"x": 1, "y": 1, "button": "x"}), s).is_err());
        assert!(validate("computer__type", &json!({"text": "a".repeat(2001)}), s).is_err());
        assert!(validate("computer__type", &json!({"text": "hi"}), s).is_ok());
        assert!(validate("computer__key", &json!({"combo": "win+l"}), s).is_err());
        assert!(validate("computer__scroll", &json!({"x": 1, "y": 1, "direction": "up", "amount": 21}), s).is_err());
        assert!(validate("computer__scroll", &json!({"x": 1, "y": 1}), s).is_err());
        assert!(validate("computer__nope", &a, s).is_err());
        assert_eq!(validate("computer__screenshot", &json!({}), None).unwrap(), Action::Screenshot);
    }

    #[tokio::test]
    async fn computer_real_screenshot_is_png_data_url() {
        let out = execute("computer__screenshot", &json!({})).await.unwrap();
        let url = out.image_data_url.unwrap();
        assert!(url.starts_with("data:image/png;base64,") && url.len() > 1000);
        assert!(out.text.starts_with("screenshot "), "{}", out.text);
        let s = LAST.lock().unwrap().unwrap();
        assert!(s.w.max(s.h) <= MAX_SIDE && s.w > 0 && s.h > 0);
    }
}
