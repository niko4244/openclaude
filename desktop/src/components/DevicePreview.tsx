import { useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { api, type DeviceInventory } from "../api";

type Preset = { id: string; name: string; width: number; height: number; dpr: number; ua: string; platform: string; frame: "island" | "home" | "punch" | "tablet" };
type PreviewEvent = { type: "frame"; data: string; width: number; height: number } | { type: "url"; url: string } | { type: "dialog"; message: string } | { type: "closed" };
type Info = { width: number; height: number; dpr: number; ua: string; touch: boolean; points: number; coarse: boolean };

const NAMED_KEYS = new Set(["Enter", "Backspace", "Tab", "Escape", "Delete", "ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home", "End"]);
/** Bezel around the screen in CSS px: [long sides, short ends] and the outer corner radius. */
const BEZEL: Record<Preset["frame"], [number, number, number]> = { island: [12, 12, 56], home: [14, 64, 46], punch: [10, 10, 40], tablet: [22, 22, 32] };

function uaLabel(ua: string) {
  return /iPhone/.test(ua) ? "iPhone Safari UA" : /iPad/.test(ua) ? "iPad Safari UA" : /Android/.test(ua) ? "Android Chrome UA" : "desktop UA";
}

/**
 * Web-app device emulation for the Code tab: a headless Edge with Chromium's device emulation
 * (viewport, pixel ratio, touch, user agent, orientation) streamed into a device outline.
 * Not a native iOS Simulator or Android Emulator; the panel says so.
 */
export function DevicePreview({ initialUrl, onClose }: { initialUrl: string | null; onClose: () => void }) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [device, setDevice] = useState(() => { try { return localStorage.getItem("oc-device") || "iphone-16-pro"; } catch { return "iphone-16-pro"; } });
  const [landscape, setLandscape] = useState(false);
  const [url, setUrl] = useState(initialUrl);
  const [draft, setDraft] = useState(initialUrl ?? "http://localhost:5173/");
  const [frame, setFrame] = useState<string | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [scale, setScale] = useState(0.6);
  const [android, setAndroid] = useState<DeviceInventory | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const opened = useRef<string | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const touching = useRef(false);
  const infoTimer = useRef<number>(0);
  const want = useRef(`${device}|${landscape}`);
  want.current = `${device}|${landscape}`;

  const preset = presets.find((p) => p.id === device);
  const [vw, vh] = preset ? (landscape ? [preset.height, preset.width] : [preset.width, preset.height]) : [0, 0];
  const [side, end, radius] = preset ? BEZEL[preset.frame] : [0, 0, 0];
  const pad = landscape ? { top: side, bottom: side, left: end, right: end } : { top: end, bottom: end, left: side, right: side };
  const outerW = vw + pad.left + pad.right;
  const outerH = vh + pad.top + pad.bottom;

  const refreshInfo = (delay = 700) => {
    window.clearTimeout(infoTimer.current);
    infoTimer.current = window.setTimeout(() => void invoke<Info>("device_preview_info").then(setInfo, () => setInfo(null)), delay);
  };

  useEffect(() => { void invoke<Preset[]>("device_presets").then(setPresets); void api.devicesInfo().then(setAndroid, () => {}); }, []);
  useEffect(() => () => { window.clearTimeout(infoTimer.current); void invoke("device_preview_close"); }, []);
  useEffect(() => { try { localStorage.setItem("oc-device", device); } catch { /* storage unavailable */ } }, [device]);
  useEffect(() => { if (initialUrl) { setUrl(initialUrl); setDraft(initialUrl); } }, [initialUrl]);

  // (Re)open whenever the URL changes; device and orientation changes are applied in place below.
  useEffect(() => {
    if (!url || !presets.length) return;
    const ch = new Channel<PreviewEvent>();
    ch.onmessage = (e) => {
      if (e.type === "frame") setFrame(e.data);
      else if (e.type === "url") { setDraft(e.url); refreshInfo(); }
      else if (e.type === "dialog") setNote(`The page showed a dialog: “${e.message}” (answered automatically)`);
      else if (e.type === "closed") setNote("The preview browser closed. Reload to reopen it.");
    };
    setErr(null);
    setFrame(null);
    opened.current = null;
    const key = want.current;
    invoke("device_preview_open", { url, device, landscape, onEvent: ch })
      .then(() => { opened.current = key; applyWanted(); refreshInfo(1200); })
      .catch((e) => setErr(String(e)));
  }, [url, presets.length]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Apply the selected device/orientation if the open preview shows something else. */
  const applyWanted = () => {
    const key = want.current;
    if (!opened.current || opened.current === key) return;
    opened.current = key;
    const [d, l] = key.split("|");
    setErr(null);
    invoke("device_preview_set", { device: d, landscape: l === "true" }).then(() => refreshInfo(1000), (e) => setErr(String(e)));
  };
  useEffect(applyWanted, [device, landscape]);

  // Fit the outline into the panel.
  useEffect(() => {
    const el = stage.current;
    if (!el || !outerW) return;
    const fit = () => setScale(Math.min(1, (el.clientWidth - 24) / outerW, (el.clientHeight - 24) / outerH));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [outerW, outerH]);

  /** Inputs go out in order (a touch end must not overtake its start). */
  const send = (input: object) => {
    queue.current = queue.current.then(() => invoke("device_preview_input", { input }).catch((e) => setErr(String(e))));
  };
  const toCss = (e: { clientX: number; clientY: number }) => {
    const r = screen.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * vw, y: ((e.clientY - r.top) / r.height) * vh };
  };
  const nav = (action: string, to?: string) => invoke("device_preview_nav", { action, url: to ?? null }).catch((e) => setErr(String(e)));
  const go = () => {
    const u = draft.trim();
    if (!u) return;
    if (u === url) void nav("go", u);
    else setUrl(u);
  };

  const emulator = android?.sdk?.emulator ? android : null;
  return (
    <aside className="artifact-panel device-panel" aria-label="Device preview">
      <div className="topbar" data-tauri-drag-region="deep" style={{ borderBottom: "1px solid var(--border)" }}>
        <span className="title">Device preview</span>
        <span className="badge" title="Chromium web emulation in a separate headless Edge: viewport, pixel ratio, touch, user agent and orientation. Not a native iOS Simulator or Android Emulator.">Web emulation</span>
        <span className="spacer" />
        <button className="icon-btn" onClick={onClose} aria-label="Close device preview">✕</button>
      </div>
      <div className="device-bar">
        <select className="btn" aria-label="Device" value={device} onChange={(e) => setDevice(e.target.value)}>
          {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button className="btn" onClick={() => setLandscape((l) => !l)} aria-pressed={landscape} title="Rotate">⟳ Rotate</button>
        <button className="icon-btn" onClick={() => void nav("back")} aria-label="Back" disabled={!url}>←</button>
        <button className="icon-btn" onClick={() => void nav("reload")} aria-label="Reload" disabled={!url}>↻</button>
      </div>
      <form className="device-bar" onSubmit={(e) => { e.preventDefault(); go(); }}>
        <input className="mono" style={{ flex: 1, minWidth: 0 }} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Preview URL" placeholder="http://localhost:5173/" spellCheck={false} />
        <button className="btn" type="submit">Open</button>
      </form>
      {err && <div className="error-box" style={{ margin: "6px 10px" }}>{err}</div>}
      <div className="device-stage" ref={stage}>
        {preset && url ? (
          <div className={`device-frame frame-${preset.frame}${landscape ? " landscape" : ""}`} data-device={preset.id} style={{ zoom: scale, width: outerW, height: outerH, padding: `${pad.top}px ${pad.right}px ${pad.bottom}px ${pad.left}px`, borderRadius: radius }}>
            <div
              ref={screen}
              className="device-screen"
              role="application"
              aria-label={`${preset.name} screen (web emulation). Click or drag to touch, scroll to scroll, type to enter text.`}
              tabIndex={0}
              style={{ width: vw, height: vh, borderRadius: Math.max(4, radius - side - 4) }}
              onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); e.currentTarget.focus(); touching.current = true; send({ kind: "touch", phase: "start", ...toCss(e) }); }}
              onPointerMove={(e) => { if (touching.current) send({ kind: "touch", phase: "move", ...toCss(e) }); }}
              onPointerUp={() => { if (touching.current) { touching.current = false; send({ kind: "touch", phase: "end", x: 0, y: 0 }); } }}
              onPointerCancel={() => { if (touching.current) { touching.current = false; send({ kind: "touch", phase: "end", x: 0, y: 0 }); } }}
              onWheel={(e) => send({ kind: "wheel", ...toCss(e), dx: e.deltaX, dy: e.deltaY })}
              onKeyDown={(e) => {
                if (e.ctrlKey || e.metaKey || e.altKey) return;
                if (NAMED_KEYS.has(e.key)) { e.preventDefault(); send({ kind: "key", key: e.key }); }
                else if (e.key.length === 1) { e.preventDefault(); send({ kind: "text", text: e.key }); }
              }}
              onPaste={(e) => { const t = e.clipboardData.getData("text"); if (t) { e.preventDefault(); send({ kind: "text", text: t.slice(0, 5000) }); } }}
            >
              {frame ? <img src={`data:image/jpeg;base64,${frame}`} alt="" draggable={false} /> : <div className="device-loading muted">Loading…</div>}
            </div>
            <span className="device-notch" aria-hidden />
            {preset.frame === "home" && <span className="device-home" aria-hidden />}
          </div>
        ) : (
          <div className="muted" style={{ padding: 16, textAlign: "center" }}>Enter your dev server's local URL above (or start it in the Terminal and choose Device preview).</div>
        )}
      </div>
      <div className="device-status mono" aria-live="polite">
        {info ? `${info.width}×${info.height} CSS px · @${info.dpr}x · ${info.touch ? `touch (${info.points} points)` : "no touch"} · ${uaLabel(info.ua)}` : url ? "…" : ""}
      </div>
      {note && <div className="muted" style={{ padding: "0 10px 6px" }}>{note}</div>}
      <div className="device-foot muted">
        Web emulation in a separate headless Edge, not a native simulator: layout, touch and user agent match the device, but Safari-only (WebKit) behavior and native APIs are not reproduced.
        <div className="device-native">
          {emulator && emulator.avds.length ? (
            <>
              <strong>Android Emulator</strong> (native): {emulator.avds.map((a) => (
                <button key={a} className="btn" style={{ marginLeft: 6 }} onClick={() => api.deviceBoot(a).then(() => setNote(`Starting ${a}… The model can drive it with the device tools once Android devices are on (Settings → General).`), (e) => setErr(String(e)))}>Start {a}</button>
              ))}
              {emulator.devices.filter((d) => d.emulator).map((d) => <span key={d.serial} className="badge" style={{ marginLeft: 6 }}>{d.serial} · {d.state}</span>)}
            </>
          ) : (
            <>
              <strong>Native Android Emulator:</strong>{" "}
              {android === null ? "checking…" : !android.sdk?.emulator
                ? "not installed. Install Android Studio, then SDK Manager → Android Emulator and a system image."
                : "installed, but there is no virtual device yet: create one in Settings → General → Android devices and emulators."}
              {android?.hypervisor === false && " It also needs Windows Hypervisor Platform, which is off on this PC: turn it on in Windows Features (“Turn Windows features on or off”) and restart. OpenClaude never changes system settings."}
            </>
          )}
        </div>
      </div>
    </aside>
  );
}
