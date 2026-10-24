// OpenClaude Desktop connector: keeps a WebSocket to the app on 127.0.0.1 and runs
// the tab actions the app sends. The app approves every action before it gets here.

let ws = null;
let status = "disconnected";

async function config() {
  const { port = 48751, token = "" } = await chrome.storage.local.get(["port", "token"]);
  return { port, token };
}

function setStatus(s) {
  status = s;
  chrome.action.setBadgeText({ text: s === "connected" ? "on" : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#1f7a68" });
}

async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const { port, token } = await config();
  if (!token) return setStatus("not paired");
  try {
    ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
  } catch {
    return setStatus("disconnected");
  }
  ws.onopen = () => setStatus("connected");
  ws.onclose = () => { setStatus("disconnected"); ws = null; };
  ws.onerror = () => setStatus("disconnected");
  ws.onmessage = async (ev) => {
    let req;
    try { req = JSON.parse(ev.data); } catch { return; }
    let reply;
    try { reply = { id: req.id, result: await handle(req.method, req.params || {}) }; }
    catch (e) { reply = { id: req.id, error: String(e && e.message ? e.message : e) }; }
    ws && ws.send(JSON.stringify(reply));
  };
}

async function tabOrActive(tabId) {
  if (Number.isInteger(tabId)) return chrome.tabs.get(tabId);
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!t) throw new Error("no active tab");
  return t;
}

function waitLoaded(tabId) {
  return new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(l); clearTimeout(t); resolve(); };
    const l = (id, info) => { if (id === tabId && info.status === "complete") done(); };
    const t = setTimeout(done, 20000);
    chrome.tabs.onUpdated.addListener(l);
  });
}

async function run(tabId, func, args) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return r ? r.result : null;
}

async function handle(method, p) {
  switch (method) {
    case "list_tabs": {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => ({ tab_id: t.id, title: t.title, url: t.url, active: t.active }));
    }
    case "navigate": {
      if (!/^https?:\/\//i.test(p.url || "")) throw new Error("only http(s) URLs");
      const t = Number.isInteger(p.tab_id) ? await chrome.tabs.update(p.tab_id, { url: p.url, active: true }) : await chrome.tabs.create({ url: p.url });
      await waitLoaded(t.id);
      const now = await chrome.tabs.get(t.id);
      return { tab_id: t.id, url: now.url };
    }
    case "read": {
      const t = await tabOrActive(p.tab_id);
      const text = await run(t.id, () => document.body ? document.body.innerText.slice(0, 30000) : "", []);
      return { url: t.url, title: t.title, text };
    }
    case "click": {
      const t = await tabOrActive(p.tab_id);
      const ok = await run(t.id, (sel) => { const el = document.querySelector(sel); if (!el) return false; el.scrollIntoView({ block: "center" }); el.click(); return true; }, [p.selector]);
      if (!ok) throw new Error(`no element matches ${p.selector}`);
      return { ok: true };
    }
    case "type": {
      const t = await tabOrActive(p.tab_id);
      const ok = await run(t.id, (sel, text) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        el.focus();
        if ("value" in el) { el.value = text; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); }
        else document.execCommand("insertText", false, text);
        return true;
      }, [p.selector, p.text || ""]);
      if (!ok) throw new Error(`no element matches ${p.selector}`);
      return { ok: true };
    }
    case "screenshot": {
      const data_url = await chrome.tabs.captureVisibleTab(undefined, { format: "png" });
      return { data_url };
    }
    default:
      throw new Error(`unknown method ${method}`);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg === "status") reply(status);
  if (msg === "reconnect") { ws && ws.close(); ws = null; connect().then(() => reply("ok")); return true; }
});
chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => connect());
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
