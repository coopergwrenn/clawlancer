// Options page — save/load gateway settings and check relay status

const gatewayUrlInput = document.getElementById("gateway-url");
const gatewayTokenInput = document.getElementById("gateway-token");
const saveBtn = document.getElementById("save-btn");
const statusEl = document.getElementById("status");

// Load saved settings on page open
chrome.storage.local.get(["gatewayUrl", "gatewayToken"], (data) => {
  if (data.gatewayUrl) gatewayUrlInput.value = data.gatewayUrl;
  if (data.gatewayToken) gatewayTokenInput.value = data.gatewayToken;
  if (data.gatewayUrl) checkRelayStatus(data.gatewayUrl);
});

// Save settings
saveBtn.addEventListener("click", () => {
  const gatewayUrl = gatewayUrlInput.value.trim().replace(/\/+$/, "");
  const gatewayToken = gatewayTokenInput.value.trim();

  if (!gatewayUrl || !gatewayToken) {
    showStatus("disconnected", "Please fill in both fields");
    return;
  }

  chrome.storage.local.set({ gatewayUrl, gatewayToken }, () => {
    showStatus("checking", "Connecting...");
    checkRelayStatus(gatewayUrl);
  });
});

async function checkRelayStatus(gatewayUrl) {
  showStatus("checking", "Checking relay...");
  try {
    const res = await fetch(`${gatewayUrl}/relay/extension/status`, {
      method: "GET",
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.connected) {
      showStatus("connected", "Connected");
    } else {
      showStatus("connected", "Relay reachable — waiting for extension connection");
    }
  } catch {
    showStatus("disconnected", "Cannot reach relay — check Gateway URL");
  }
}

function showStatus(state, message) {
  statusEl.innerHTML = `<span class="dot dot-${state}"></span> ${message}`;
}
