//! Record a skill: sample the primary screen while the user does a task and narrates it,
//! then have a vision model on the gateway write a reusable Claude-format SKILL.md.
//!
//! Privacy: a recording starts only from an explicit click in the UI and shows an
//! always-on-top indicator. It is not a model tool, so chats and background tasks cannot
//! start it. Frames live in a temporary folder that is deleted on save, discard, cancel and
//! the next app start; only the subsample sent to the user's chosen model leaves the device.

use crate::computer;
use crate::gateway::{Delta, Gateway};
use crate::plugins::{self, Plugins};
use anyhow::{Context, Result, anyhow, bail};
use base64::Engine as _;
use serde::Serialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use xcap::image::{RgbaImage, imageops};

/// How often the screen is checked for change.
const TICK: Duration = Duration::from_millis(1000);
/// A frame that changed only a little is still kept after this long.
const PERIOD_MS: u64 = 2000;
pub const MAX_FRAMES: usize = 60;
/// Frames sent to the model (evenly spread, first and last always included).
pub const MAX_SENT: usize = 8;
/// Capture stops after this long even if the indicator is gone.
pub const MAX_DURATION: Duration = Duration::from_secs(10 * 60);
const FRAME_SIDE: u32 = 1280;
const PREVIEW_SIDE: u32 = 320;
const THUMB: (u32, u32) = (64, 36);
/// A fingerprint pixel counts as changed when its luma moves more than this.
const PIXEL_DELTA: u8 = 24;
/// Share of changed fingerprint pixels that is a visible change (menu, dialog, new page): kept at once.
const VISIBLE: f32 = 0.01;
/// At or below this share a frame is a duplicate (cursor blink, clock): never kept.
const DUPLICATE: f32 = 0.002;
pub const PLUGIN_ID: &str = "recorded-skills";
const NAME_MAX: usize = 64;
const DESCRIPTION_MAX: usize = 1024;

// ---------- frame sampling (pure)

/// 64x36 luma fingerprint used to compare frames.
pub fn thumb(img: &RgbaImage) -> Vec<u8> {
    imageops::resize(img, THUMB.0, THUMB.1, imageops::FilterType::Triangle)
        .pixels()
        .map(|p| ((p[0] as u32 * 299 + p[1] as u32 * 587 + p[2] as u32 * 114) / 1000) as u8)
        .collect()
}

/// Share of fingerprint pixels that changed visibly (0..=1).
pub fn change(a: &[u8], b: &[u8]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 1.0;
    }
    a.iter().zip(b).filter(|(x, y)| x.abs_diff(**y) > PIXEL_DELTA).count() as f32 / a.len() as f32
}

/// Keep a frame that differs this much from the last kept one, taken `since_ms` after it?
pub fn keep(change: f32, since_ms: u64) -> bool {
    change >= VISIBLE || (since_ms >= PERIOD_MS && change > DUPLICATE)
}

pub struct Sample<T> {
    pub t_ms: u64,
    thumb: Vec<u8>,
    /// Change from the previous kept frame.
    change: f32,
    pub item: T,
}

/// Kept frames: the first, then every visible change, plus small changes every PERIOD_MS;
/// over MAX_FRAMES the most redundant interior frame is dropped.
pub struct Sampler<T> {
    pub frames: Vec<Sample<T>>,
}

impl<T> Default for Sampler<T> {
    fn default() -> Self {
        Self { frames: vec![] }
    }
}

impl<T> Sampler<T> {
    pub fn wants(&self, t_ms: u64, thumb: &[u8]) -> bool {
        self.frames.last().is_none_or(|l| keep(change(&l.thumb, thumb), t_ms.saturating_sub(l.t_ms)))
    }

    /// Keep a frame; returns the one thinned out to stay at MAX_FRAMES, if any.
    pub fn push(&mut self, t_ms: u64, thumb: Vec<u8>, item: T) -> Option<T> {
        let c = self.frames.last().map_or(1.0, |l| change(&l.thumb, &thumb));
        self.frames.push(Sample { t_ms, thumb, change: c, item });
        if self.frames.len() <= MAX_FRAMES {
            return None;
        }
        // The interior frame closest to its predecessor adds the least; the first and last stay.
        let n = self.frames.len();
        let i = (1..n - 1).min_by(|&a, &b| self.frames[a].change.total_cmp(&self.frames[b].change)).unwrap();
        let gone = self.frames.remove(i);
        self.frames[i].change = change(&self.frames[i - 1].thumb, &self.frames[i].thumb);
        Some(gone.item)
    }
}

/// `k` indices spread evenly over `n` frames, first and last included.
pub fn subsample(n: usize, k: usize) -> Vec<usize> {
    if n <= k {
        return (0..n).collect();
    }
    if k <= 1 {
        return if k == 1 { vec![n - 1] } else { vec![] };
    }
    (0..k).map(|i| (i * (n - 1) + (k - 1) / 2) / (k - 1)).collect()
}

// ---------- skill files (pure)

/// Folder- and invocation-safe skill name: lowercase ASCII letters, digits and single hyphens,
/// at most 64 characters, never empty or a reserved Windows device name.
pub fn safe_name(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    out.truncate(NAME_MAX);
    let mut out = out.trim_end_matches('-').to_string();
    if out.is_empty() {
        out = "recorded-skill".into();
    }
    let b = out.as_bytes();
    let device = ["con", "prn", "aux", "nul"].contains(&out.as_str())
        || (b.len() == 4 && (out.starts_with("com") || out.starts_with("lpt")) && b[3].is_ascii_digit());
    if device {
        out.push_str("-skill");
    }
    out
}

/// YAML single-quoted scalar: any one-line text is valid inside, only `'` is doubled.
fn yaml_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Write `<root>/skills/<name>/SKILL.md`. The name is made safe and unique: an existing
/// folder or a name `taken` by another skill gets a `-2`, `-3`, … suffix. Returns (name, path).
pub fn write_skill(root: &Path, name: &str, description: &str, body: &str, taken: impl Fn(&str) -> bool) -> Result<(String, PathBuf)> {
    let description: String = one_line(description).chars().take(DESCRIPTION_MAX).collect();
    if description.is_empty() {
        bail!("Add a description: it tells the assistant when to use the skill.");
    }
    let (_, body) = plugins::frontmatter(body);
    let body = body.trim();
    if body.is_empty() {
        bail!("The skill has no steps.");
    }
    let base = safe_name(name);
    let skills = root.join("skills");
    let mut n = 1;
    let name = loop {
        let cand = if n == 1 {
            base.clone()
        } else {
            let sfx = format!("-{n}");
            format!("{}{sfx}", base[..base.len().min(NAME_MAX - sfx.len())].trim_end_matches('-'))
        };
        if !skills.join(&cand).exists() && !taken(&cand) {
            break cand;
        }
        n += 1;
    };
    let dir = skills.join(&name);
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("SKILL.md");
    let tmp = dir.join("SKILL.md.tmp");
    std::fs::write(&tmp, format!("---\nname: {name}\ndescription: {}\n---\n\n{body}\n", yaml_quote(&description)))?;
    std::fs::rename(&tmp, &path)?;
    Ok((name, path))
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Draft {
    pub name: String,
    pub description: String,
    pub body: String,
}

/// Read the model's SKILL.md: tolerates a code fence, text before the front matter, or none at all.
pub fn parse_draft(reply: &str) -> Draft {
    let reply = reply.replace("\r\n", "\n");
    let mut t = reply.trim();
    if let Some(rest) = t.strip_prefix("```") {
        t = rest.split_once('\n').map_or("", |(_, r)| r);
        t = t.trim_end().strip_suffix("```").unwrap_or(t);
    }
    // "Here is the skill:" before the front matter
    if let Some(i) = t.find("\n---\n").filter(|&i| !t.starts_with("---") && plugins::frontmatter(&t[i + 1..]).0.contains_key("name")) {
        t = &t[i + 1..];
    }
    let (fm, body) = plugins::frontmatter(t);
    let body = body.trim().to_string();
    let heading = body.lines().find_map(|l| l.strip_prefix("# ")).unwrap_or("");
    let name = safe_name(fm.get("name").map(String::as_str).filter(|s| !s.is_empty()).unwrap_or(heading));
    let description = fm.get("description").cloned().filter(|d| !d.is_empty()).unwrap_or_else(|| {
        body.split("\n\n").find(|p| !p.trim_start().starts_with('#')).map(one_line).unwrap_or_default()
    });
    Draft { name, description: one_line(&description), body }
}

const SYSTEM: &str = "You write reusable skills for an AI assistant from a screen recording. The user recorded \
their screen while doing a task and narrated it. Study the frames in order together with the narration and notes, \
work out the task they performed, and write a skill that lets an assistant repeat it for them later.

Reply with only the skill file, in exactly this shape:
---
name: short-kebab-case-name
description: One or two sentences on what the skill does and when to use it.
---
# <the task in a few words>

## Inputs
- what the user has to provide each time (or: None)

## Steps
1. Concrete, ordered actions naming the apps, menus, buttons, fields and values seen in the frames.

## Checks
- How to confirm the important steps worked and the task is done.

Rules: the name uses lowercase letters, digits and hyphens, at most 64 characters. Generalize: values that will \
change between runs become inputs. Do not invent steps you cannot see or hear; put open questions under a \
## Notes section. Never copy passwords, keys or other secrets that are visible on screen.";

fn clock(ms: u64) -> String {
    format!("{}:{:02}", ms / 60_000, ms / 1000 % 60)
}

/// The user message: narration, timestamped notes, then the frames with their times.
pub fn prompt(duration_ms: u64, total: usize, narration: &str, notes: &[Note], frames: &[(u64, String)]) -> Value {
    let notes = if notes.is_empty() {
        "(none)".to_string()
    } else {
        notes.iter().map(|n| format!("[{}] {}", clock(n.t_ms), n.text)).collect::<Vec<_>>().join("\n")
    };
    let narration = if narration.trim().is_empty() { "(none)" } else { narration.trim() };
    let mut parts = vec![json!({"type": "text", "text": format!(
        "Recording: {} long, {} frames shown of {total} captured.\n\nNarration (transcribed speech):\n{narration}\n\nTyped notes:\n{notes}",
        clock(duration_ms), frames.len())})];
    for (i, (t, url)) in frames.iter().enumerate() {
        parts.push(json!({"type": "text", "text": format!("Frame {} at {}:", i + 1, clock(*t))}));
        parts.push(json!({"type": "image_url", "image_url": {"url": url}}));
    }
    json!({"role": "user", "content": parts})
}

// ---------- the recording session

#[derive(Serialize, Clone, Debug)]
pub struct Note {
    pub t_ms: u64,
    pub text: String,
}

struct Session {
    dir: PathBuf,
    started: Instant,
    sampler: Sampler<PathBuf>,
    /// Frames looked at, kept or not.
    captured: usize,
    notes: Vec<Note>,
    audio: Option<(PathBuf, String)>,
    ended_ms: Option<u64>,
    error: Option<String>,
    cancel: Arc<tokio::sync::Notify>,
}

impl Session {
    fn elapsed(&self) -> u64 {
        self.ended_ms.unwrap_or_else(|| self.started.elapsed().as_millis() as u64)
    }
}

static CURRENT: Mutex<Option<Session>> = Mutex::new(None);
/// Bumped on every start and discard, so a capture loop never writes into another session.
static GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize, Clone, Debug)]
pub struct Status {
    pub recording: bool,
    pub elapsed_ms: u64,
    pub frames: usize,
    pub notes: Vec<Note>,
    pub has_audio: bool,
    pub error: Option<String>,
}

fn status_of(s: &Session) -> Status {
    Status {
        recording: s.ended_ms.is_none(),
        elapsed_ms: s.elapsed(),
        frames: s.sampler.frames.len(),
        notes: s.notes.clone(),
        has_audio: s.audio.is_some(),
        error: s.error.clone(),
    }
}

pub fn status() -> Option<Status> {
    CURRENT.lock().unwrap().as_ref().map(status_of)
}

/// Delete leftovers of a recording that was never saved (crash, kill).
pub fn purge(dir: &Path) {
    let _ = std::fs::remove_dir_all(dir);
}

/// Begin recording into a fresh folder under `dir`; a finished, unsaved recording is discarded.
pub fn start(dir: &Path) -> Result<()> {
    let mut cur = CURRENT.lock().unwrap();
    if cur.as_ref().is_some_and(|s| s.ended_ms.is_none()) {
        bail!("A recording is already running.");
    }
    if let Some(old) = cur.take() {
        old.cancel.notify_one();
        let _ = std::fs::remove_dir_all(&old.dir);
    }
    let gen_id = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let dir = dir.join(uuid::Uuid::new_v4().simple().to_string());
    std::fs::create_dir_all(&dir)?;
    *cur = Some(Session {
        dir,
        started: Instant::now(),
        sampler: Sampler::default(),
        captured: 0,
        notes: vec![],
        audio: None,
        ended_ms: None,
        error: None,
        cancel: Arc::new(tokio::sync::Notify::new()),
    });
    tauri::async_runtime::spawn(capture_loop(gen_id));
    Ok(())
}

fn live(gen_id: u64) -> bool {
    GENERATION.load(Ordering::SeqCst) == gen_id
}

/// Take a frame and keep it if it adds something. Returns false once the session is over.
async fn tick(gen_id: u64) -> bool {
    let shot = tokio::task::spawn_blocking(|| computer::grab(FRAME_SIDE)).await;
    let (img, th, t_ms, file) = {
        let mut cur = CURRENT.lock().unwrap();
        let Some(s) = cur.as_mut().filter(|s| s.ended_ms.is_none() && live(gen_id)) else { return false };
        let img = match shot {
            Ok(Ok((img, _, _))) => img,
            Ok(Err(e)) => {
                s.error = Some(format!("Screen capture failed: {e}"));
                return true;
            }
            Err(e) => {
                s.error = Some(e.to_string());
                return true;
            }
        };
        let t_ms = s.started.elapsed().as_millis() as u64;
        s.captured += 1;
        let th = thumb(&img);
        if !s.sampler.wants(t_ms, &th) {
            return true;
        }
        (img, th, t_ms, s.dir.join(format!("frame-{t_ms:07}.png")))
    };
    let f = file.clone();
    let written = tokio::task::spawn_blocking(move || computer::png(img).and_then(|b| Ok(std::fs::write(&f, b)?))).await;
    let mut cur = CURRENT.lock().unwrap();
    let Some(s) = cur.as_mut().filter(|_| live(gen_id)) else {
        let _ = std::fs::remove_file(&file);
        return false;
    };
    match written {
        Ok(Ok(())) => {
            s.error = None;
            if let Some(old) = s.sampler.push(t_ms, th, file) {
                let _ = std::fs::remove_file(old);
            }
        }
        Ok(Err(e)) => s.error = Some(format!("Could not store a frame: {e}")),
        Err(e) => s.error = Some(e.to_string()),
    }
    true
}

async fn capture_loop(gen_id: u64) {
    let started = Instant::now();
    while started.elapsed() < MAX_DURATION && tick(gen_id).await {
        tokio::time::sleep(TICK).await;
    }
}

pub fn note(text: &str) -> Result<()> {
    let text = one_line(text);
    if text.is_empty() {
        return Ok(());
    }
    let mut cur = CURRENT.lock().unwrap();
    let s = cur.as_mut().filter(|s| s.ended_ms.is_none()).ok_or_else(|| anyhow!("Not recording."))?;
    let t_ms = s.started.elapsed().as_millis() as u64;
    s.notes.push(Note { t_ms, text: text.chars().take(2000).collect() });
    Ok(())
}

/// Stop: take a last frame (the end state), store the narration audio, keep the session for review.
pub async fn stop(audio: Option<(Vec<u8>, String)>) -> Result<Status> {
    let gen_id = GENERATION.load(Ordering::SeqCst);
    if !CURRENT.lock().unwrap().as_ref().is_some_and(|s| s.ended_ms.is_none()) {
        bail!("Not recording.");
    }
    tick(gen_id).await;
    let mut cur = CURRENT.lock().unwrap();
    let s = cur.as_mut().filter(|s| s.ended_ms.is_none()).ok_or_else(|| anyhow!("Not recording."))?;
    s.ended_ms = Some(s.started.elapsed().as_millis() as u64);
    if let Some((bytes, mime)) = audio.filter(|(b, _)| !b.is_empty()) {
        let p = s.dir.join("narration.audio");
        std::fs::write(&p, bytes).context("store narration")?;
        s.audio = Some((p, mime));
    }
    if s.sampler.frames.is_empty() {
        let err = s.error.clone().unwrap_or_else(|| "No frames were captured.".into());
        let _ = std::fs::remove_dir_all(&s.dir);
        *cur = None;
        bail!("{err}");
    }
    Ok(status_of(s))
}

/// Delete the recording (running or finished) and its files; stops a running generation.
pub fn discard() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    if let Some(s) = CURRENT.lock().unwrap().take() {
        s.cancel.notify_one();
        let _ = std::fs::remove_dir_all(&s.dir);
    }
}

fn finished<R>(f: impl FnOnce(&Session) -> R) -> Result<R> {
    let cur = CURRENT.lock().unwrap();
    let s = cur.as_ref().filter(|s| s.ended_ms.is_some()).ok_or_else(|| anyhow!("No finished recording to review."))?;
    Ok(f(s))
}

fn data_url(png: &[u8]) -> String {
    format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png))
}

/// The frames that will be sent to the model: (time, file).
fn sent_frames(s: &Session) -> Vec<(u64, PathBuf)> {
    let f = &s.sampler.frames;
    subsample(f.len(), MAX_SENT).into_iter().map(|i| (f[i].t_ms, f[i].item.clone())).collect()
}

#[derive(Serialize)]
pub struct Preview {
    pub t_ms: u64,
    pub data_url: String,
}

/// Small previews of exactly the frames the model will see.
pub async fn previews() -> Result<Vec<Preview>> {
    let frames = finished(sent_frames)?;
    tokio::task::spawn_blocking(move || {
        frames
            .into_iter()
            .map(|(t_ms, f)| -> Result<Preview> {
                let img = xcap::image::open(&f)?.to_rgba8();
                Ok(Preview { t_ms, data_url: data_url(&computer::png(computer::fit(img, PREVIEW_SIDE))?) })
            })
            .collect()
    })
    .await?
}

/// Narration audio to text (gateway STT or local faster-whisper); empty when there was none.
pub async fn transcribe(gw: &Gateway, stt_model: Option<&str>) -> Result<String> {
    let (audio, dir) = finished(|s| (s.audio.clone(), s.dir.clone()))?;
    let Some((path, mime)) = audio else { return Ok(String::new()) };
    let bytes = tokio::fs::read(&path).await?;
    crate::voice::transcribe(gw, stt_model, bytes, &mime, &dir.join("voice")).await
}

/// Ask the vision model for the skill; `on_text` receives the reply as it streams.
pub async fn generate(gw: &Gateway, model: &str, narration: &str, mut on_text: impl FnMut(String)) -> Result<Draft> {
    let (frames, notes, duration, total, cancel) =
        finished(|s| (sent_frames(s), s.notes.clone(), s.elapsed(), s.captured.max(s.sampler.frames.len()), s.cancel.clone()))?;
    let images = tokio::task::spawn_blocking(move || -> Result<Vec<(u64, String)>> {
        frames.into_iter().map(|(t, f)| Ok((t, data_url(&std::fs::read(f)?)))).collect()
    })
    .await??;
    let messages = [json!({"role": "system", "content": SYSTEM}), prompt(duration, total, narration, &notes, &images)];
    let extra = json!({"temperature": 0.2, "max_tokens": 3000});
    let c = gw
        .stream_chat(model, &messages, None, Some(&extra), &cancel, |d| {
            if let Delta::Text { text } = d {
                on_text(text);
            }
        })
        .await?;
    if c.cancelled {
        bail!("Cancelled.");
    }
    if c.content.trim().is_empty() {
        bail!("{model} returned no text. Pick a model that can read images.");
    }
    Ok(parse_draft(&c.content))
}

#[derive(Serialize)]
pub struct Saved {
    pub name: String,
    pub path: String,
}

/// Save the reviewed skill, register the recorded-skills folder once, and delete the recording.
pub fn save(plugins: &Plugins, root: &Path, name: &str, description: &str, body: &str) -> Result<Saved> {
    finished(|_| ())?;
    let index = plugins.index();
    let (name, path) = write_skill(root, name, description, body, |n| index.iter().any(|c| c.name == n))?;
    register(plugins, root)?;
    discard();
    Ok(Saved { name, path: path.to_string_lossy().into() })
}

/// Recorded skills are a user-scope plugin: bare `/name` in the "/" menu and in skills__search.
pub fn register(plugins: &Plugins, root: &Path) -> Result<()> {
    std::fs::create_dir_all(root.join("skills"))?;
    if !plugins.registry().plugins.iter().any(|p| p.id == PLUGIN_ID) {
        plugins.add_local(root, "Recorded skills", true, Some(PLUGIN_ID))?;
    }
    plugins.reindex();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PX: usize = (THUMB.0 * THUMB.1) as usize;

    fn th(v: u8) -> Vec<u8> {
        vec![v; PX]
    }
    /// Black fingerprint with the pixels in `range` white.
    fn th_with(range: std::ops::Range<usize>) -> Vec<u8> {
        let mut t = th(0);
        t[range].iter_mut().for_each(|p| *p = 255);
        t
    }

    #[test]
    fn record_change_counts_visibly_changed_pixels() {
        assert_eq!(change(&th(10), &th(10)), 0.0);
        assert_eq!(change(&th(10), &th(10 + PIXEL_DELTA)), 0.0, "small luma noise is not a change");
        assert_eq!(change(&th(0), &th(255)), 1.0);
        assert!((change(&th(0), &th_with(0..23)) - 23.0 / PX as f32).abs() < 1e-6);
        assert_eq!(change(&th(0), &[0, 0]), 1.0, "mismatched sizes count as different");
        let img = RgbaImage::from_pixel(1280, 720, xcap::image::Rgba([200, 100, 50, 255]));
        let t = thumb(&img);
        assert_eq!(t.len(), PX);
        assert!(t.iter().all(|&v| v == t[0]));
    }

    #[test]
    fn record_sampler_keeps_changes_and_drops_duplicates() {
        let mut s = Sampler::<u32>::default();
        assert!(s.wants(0, &th(0)), "first frame is always kept");
        s.push(0, th(0), 0);
        assert!(!s.wants(1000, &th(0)), "identical frame is a duplicate");
        assert!(!s.wants(60_000, &th(0)), "duplicates are dropped however long the gap");
        assert!(!s.wants(60_000, &th_with(0..2)), "a cursor blink is a duplicate");
        let small = th_with(0..10); // 0.4%: more than a duplicate, less than a visible change
        assert!(!s.wants(1000, &small), "a small change waits for the period");
        assert!(s.wants(PERIOD_MS, &small), "a small change is kept after the period");
        let big = th_with(0..200);
        assert!(s.wants(1000, &big), "a visible change is kept at once");
        s.push(1000, big.clone(), 1);
        assert_eq!(s.frames.len(), 2);
        assert!(!s.wants(2000, &big));
    }

    #[test]
    fn record_sampler_caps_frames_and_thins_the_most_redundant() {
        let mut s = Sampler::<usize>::default();
        let mut dropped = vec![];
        for i in 0..=MAX_FRAMES {
            // each frame lights a different band; #7 repeats #6's band but one pixel
            let t = if i == 7 { let mut t = th_with(6 * 30..6 * 30 + 30); t[6 * 30] = 0; t } else { th_with(i * 30..i * 30 + 30) };
            if let Some(d) = s.push(i as u64 * 1000, t, i) {
                dropped.push(d);
            }
        }
        assert_eq!(s.frames.len(), MAX_FRAMES);
        assert_eq!(dropped, vec![7], "the near-copy is thinned out");
        assert_eq!(s.frames[0].item, 0, "first frame stays");
        assert_eq!(s.frames.last().unwrap().item, MAX_FRAMES, "last frame stays");
        // a long recording: always capped, ends kept, times in order
        for i in MAX_FRAMES + 1..400 {
            let a = i * 37 % (PX - 40);
            s.push(i as u64 * 1000, th_with(a..a + 40), i);
        }
        assert_eq!(s.frames.len(), MAX_FRAMES);
        assert_eq!(s.frames[0].item, 0);
        assert_eq!(s.frames.last().unwrap().item, 399);
        assert!(s.frames.windows(2).all(|w| w[0].t_ms < w[1].t_ms));
    }

    #[test]
    fn record_subsample_is_even_and_keeps_ends() {
        assert_eq!(subsample(3, 8), vec![0, 1, 2]);
        assert_eq!(subsample(0, 8), Vec::<usize>::new());
        let s = subsample(60, 8);
        assert_eq!(s.len(), 8);
        assert_eq!((s[0], s[7]), (0, 59));
        assert!(s.windows(2).all(|w| (8..=9).contains(&(w[1] - w[0]))), "{s:?}");
        let s = subsample(9, 8);
        assert_eq!((s.len(), s[0], s[7]), (8, 0, 8));
        assert!(s.windows(2).all(|w| w[0] < w[1]), "{s:?}");
        assert_eq!(subsample(5, 1), vec![4]);
    }

    #[test]
    fn record_safe_names() {
        assert_eq!(safe_name("Export Monthly Invoices!"), "export-monthly-invoices");
        assert_eq!(safe_name("../../etc/passwd"), "etc-passwd");
        assert_eq!(safe_name("..\\..\\Windows\\System32"), "windows-system32");
        assert_eq!(safe_name("a -- b__c"), "a-b-c");
        assert_eq!(safe_name("café au lait"), "caf-au-lait");
        assert_eq!(safe_name(""), "recorded-skill");
        assert_eq!(safe_name("!!!"), "recorded-skill");
        assert_eq!(safe_name("CON"), "con-skill");
        assert_eq!(safe_name("lpt1"), "lpt1-skill");
        assert_eq!(safe_name("com10"), "com10");
        let (w, z) = ("word ".repeat(40), "z".repeat(200));
        for n in ["x", "My Skill", "../a", "CON", w.as_str(), z.as_str()] {
            let s = safe_name(n);
            assert!(s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'), "{s}");
            assert!(!s.starts_with('-') && !s.ends_with('-') && !s.contains("--") && s.len() <= NAME_MAX, "{s}");
        }
    }

    #[test]
    fn record_write_skill_front_matter_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let desc = "Use when: exporting \"monthly\" invoices; it's quick # not a comment\n---\nsecond line";
        let body = "# Export invoices\n\n## Steps\n1. Open the app";
        let (name, path) = write_skill(dir.path(), "Export Invoices", desc, body, |_| false).unwrap();
        assert_eq!(name, "export-invoices");
        assert_eq!(path, dir.path().join("skills").join("export-invoices").join("SKILL.md"));
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.starts_with("---\nname: export-invoices\ndescription: '"), "{text}");
        assert_eq!(text.lines().filter(|l| *l == "---").count(), 2, "the description cannot open or close front matter:\n{text}");
        let (fm, rest) = plugins::frontmatter(&text);
        assert_eq!(fm["name"], "export-invoices");
        assert_eq!(fm["description"], "Use when: exporting \"monthly\" invoices; it's quick # not a comment --- second line");
        assert_eq!(rest.trim(), body);
        // the plugin index sees it as a bare user-scope skill
        let p = plugins::local_plugin(dir.path(), "Recorded skills", true, Some(PLUGIN_ID));
        let c = plugins::components(&p);
        assert_eq!(c.len(), 1);
        assert_eq!((c[0].kind, c[0].name.as_str()), ("skill", "export-invoices"));
        assert!(c[0].description.starts_with("Use when: exporting"));
    }

    #[test]
    fn record_write_skill_never_overwrites_and_validates() {
        let dir = tempfile::tempdir().unwrap();
        let (a, _) = write_skill(dir.path(), "Same", "d", "steps", |_| false).unwrap();
        let (b, _) = write_skill(dir.path(), "Same", "d", "steps", |_| false).unwrap();
        let (c, _) = write_skill(dir.path(), "same", "d", "steps", |n| n == "same-3").unwrap();
        assert_eq!((a.as_str(), b.as_str(), c.as_str()), ("same", "same-2", "same-4"));
        let (long, _) = write_skill(dir.path(), &"y".repeat(100), "d", "s", |_| false).unwrap();
        let (long2, _) = write_skill(dir.path(), &"y".repeat(100), "d", "s", |_| false).unwrap();
        assert_eq!(long.len(), NAME_MAX);
        assert!(long2.len() <= NAME_MAX && long2.ends_with("-2"), "{long2}");
        assert!(write_skill(dir.path(), "x", "  ", "steps", |_| false).is_err(), "a description is required");
        assert!(write_skill(dir.path(), "x", "d", "---\nname: x\n---\n", |_| false).is_err(), "a body is required");
        // front matter the user left in the body is replaced, not duplicated
        let (n, p) = write_skill(dir.path(), "x", "d", "---\nname: evil\ndescription: other\n---\nDo it", |_| false).unwrap();
        assert_eq!(n, "x");
        assert_eq!(std::fs::read_to_string(p).unwrap(), "---\nname: x\ndescription: 'd'\n---\n\nDo it\n");
        let p = write_skill(dir.path(), "z", &"w".repeat(5000), "s", |_| false).unwrap().1;
        let (fm, _) = plugins::frontmatter(&std::fs::read_to_string(p).unwrap());
        assert_eq!(fm["description"].len(), DESCRIPTION_MAX);
    }

    #[test]
    fn record_parse_draft_tolerates_model_formatting() {
        let plain = "---\nname: Rename Photos\ndescription: Renames photos by date.\n---\n# Rename photos\n\n## Steps\n1. Open the folder";
        let d = parse_draft(plain);
        assert_eq!(d, Draft { name: "rename-photos".into(), description: "Renames photos by date.".into(), body: "# Rename photos\n\n## Steps\n1. Open the folder".into() });
        assert_eq!(parse_draft(&format!("```markdown\n{plain}\n```")), d);
        assert_eq!(parse_draft(&format!("Here is the skill:\n\n{plain}")), d);
        let bare = parse_draft("# Backup Notes\n\nCopies the notes folder to the backup drive.\n\n## Steps\n1. Copy");
        assert_eq!(bare.name, "backup-notes");
        assert_eq!(bare.description, "Copies the notes folder to the backup drive.");
        assert!(bare.body.starts_with("# Backup Notes"));
        assert_eq!(parse_draft("").name, "recorded-skill");
    }

    #[test]
    fn record_prompt_has_notes_frames_and_times() {
        let notes = vec![Note { t_ms: 5_000, text: "open settings".into() }, Note { t_ms: 65_000, text: "save".into() }];
        let frames = vec![(0, "data:image/png;base64,AA".to_string()), (61_000, "data:image/png;base64,BB".to_string())];
        let m = prompt(70_000, 12, "  first I open the app ", &notes, &frames);
        let parts = m["content"].as_array().unwrap();
        assert_eq!(parts.len(), 1 + 2 * 2);
        let intro = parts[0]["text"].as_str().unwrap();
        assert!(intro.contains("1:10 long, 2 frames shown of 12"), "{intro}");
        assert!(intro.contains("first I open the app") && intro.contains("[0:05] open settings") && intro.contains("[1:05] save"), "{intro}");
        assert_eq!(parts[3]["text"], "Frame 2 at 1:01:");
        assert_eq!(parts[4]["image_url"]["url"], "data:image/png;base64,BB");
        assert!(prompt(1000, 1, "", &[], &[])["content"][0]["text"].as_str().unwrap().contains("(none)"));
    }

    #[test]
    fn record_register_once_and_index_sees_new_skills() {
        let data = tempfile::tempdir().unwrap();
        let pl = Plugins::new(data.path().join("plugins"));
        let root = data.path().join("recorded-skills");
        register(&pl, &root).unwrap();
        assert!(pl.index().is_empty());
        write_skill(&root, "Daily Report", "Builds the daily report.", "## Steps\n1. Go", |_| false).unwrap();
        register(&pl, &root).unwrap();
        let reg = pl.registry();
        assert_eq!(reg.plugins.iter().filter(|p| p.id == PLUGIN_ID).count(), 1, "registered once");
        assert!(reg.plugins[0].user_scope && !reg.plugins[0].hooks);
        assert_eq!(pl.find("daily-report").map(|c| c.kind), Some("skill"));
        let hits = plugins::search(&pl.index(), "daily report", 5);
        assert_eq!(hits.first().map(|c| c.name.as_str()), Some("daily-report"));
    }
}
