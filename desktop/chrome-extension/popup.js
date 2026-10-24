const $ = (id) => document.getElementById(id);
const refresh = () => chrome.runtime.sendMessage("status", (s) => { $("status").textContent = `Status: ${s || "unknown"}`; });
chrome.storage.local.get(["port", "token"], ({ port = 48751, token = "" }) => { $("port").value = port; $("token").value = token; refresh(); });
$("save").onclick = async () => {
  await chrome.storage.local.set({ port: Number($("port").value) || 48751, token: $("token").value.trim() });
  chrome.runtime.sendMessage("reconnect", () => setTimeout(refresh, 800));
};
