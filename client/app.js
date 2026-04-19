const WS_URL =
    window.location.hostname === "localhost"
        ? "ws://localhost:8080"
        : "wss://udp-simulator.onrender.com";

const ws = new WebSocket(WS_URL);

const protocolInput = document.getElementById("protocol");
const messageInput = document.getElementById("messageInput");
const sendBtn = document.getElementById("sendBtn");
const stopBtn = document.getElementById("stopBtn");
const timeline = document.getElementById("timeline");
const senderState = document.getElementById("senderState");
const receiverState = document.getElementById("receiverState");
const sessionInfo = document.getElementById("sessionInfo");
const liveTimer = document.getElementById("liveTimer");
const packetLayer = document.getElementById("packetLayer");
let sessionStartMs = null;
let timerIntervalId = null;

ws.onopen = () => {
    sessionInfo.textContent = "Connected to simulator";
};

ws.onclose = () => {
    sessionInfo.textContent = "Connection closed";
    stopLiveTimer();
};

ws.onerror = () => {
    sessionInfo.textContent = "Connection error";
    stopLiveTimer();
};

ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.event === "reset") {
        timeline.innerHTML = "";
        packetLayer.innerHTML = "";
        senderState.textContent = "Preparing packets...";
        receiverState.textContent = "Waiting...";
        sessionInfo.textContent = `Running ${data.protocolName}`;
        startLiveTimer();
        return;
    }

    if (data.event === "log") {
        appendLog(data);
        animateTransmission(data);
        senderState.textContent = data.senderState || senderState.textContent;
        receiverState.textContent = data.receiverState || receiverState.textContent;
        return;
    }

    if (data.event === "done") {
        senderState.textContent = "Done";
        receiverState.textContent = "All data received";
        sessionInfo.textContent = `${data.protocolName} finished`;
        stopLiveTimer();
    }
};

sendBtn.addEventListener("click", () => {
    if (ws.readyState !== WebSocket.OPEN) {
        sessionInfo.textContent = "WebSocket is not connected";
        return;
    }

    const payload = {
        action: "start",
        protocol: protocolInput.value,
        message: messageInput.value || "Default message"
    };

    ws.send(JSON.stringify(payload));
});

stopBtn.addEventListener("click", () => {
    if (ws.readyState !== WebSocket.OPEN) {
        return;
    }
    ws.send(JSON.stringify({ action: "stop" }));
    sessionInfo.textContent = "Stopped";
    stopLiveTimer();
});

function appendLog(data) {
    if (shouldHideEvent(data)) {
        return;
    }

    const row = document.createElement("div");
    row.className = "event-row";

    const statusClass = data.status === "ok" ? "ok" : data.status === "warn" ? "warn" : "bad";

    row.innerHTML = `
        <div class="time-stamp">${escapeHtml(formatEventTime())}</div>
        <div class="tag">${escapeHtml(data.tag)}</div>
        <div>${escapeHtml(data.text)}</div>
        <div class="${statusClass}">${escapeHtml(data.statusLabel || data.status)}</div>
    `;

    timeline.appendChild(row);
    timeline.scrollTop = timeline.scrollHeight;
}

function escapeHtml(text) {
    return String(text)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function animateTransmission(data) {
    if (shouldHideEvent(data)) {
        return;
    }

    if (!data.tag || (!data.tag.startsWith("PKT") && !data.tag.startsWith("ACK"))) {
        return;
    }

    const isAck = data.tag.startsWith("ACK");
    const label = `${data.tag} ${isAck ? "<-" : "->"} ${data.statusLabel || ""}`.trim();
    const isFail = String(data.statusLabel || "").toUpperCase().includes("LOST");

    const token = document.createElement("div");
    token.className = `moving-token ${isAck ? "ack" : "pkt"}${isFail ? " fail" : ""}`;
    token.textContent = label;
    packetLayer.appendChild(token);

    const channelWidth = packetLayer.clientWidth;
    const tokenWidth = Math.max(96, Math.min(150, label.length * 7));
    const leftEdge = 6;
    const rightEdge = Math.max(leftEdge + 2, channelWidth - tokenWidth - 6);
    const startX = isAck ? rightEdge : leftEdge;
    const endX = isFail ? Math.floor((leftEdge + rightEdge) / 2) : (isAck ? leftEdge : rightEdge);

    token.style.transition = "none";
    token.style.transform = `translate(${startX}px, -50%)`;
    token.offsetHeight;

    requestAnimationFrame(() => {
        token.style.transition = "transform 1450ms linear, opacity 320ms ease";
        token.style.transform = `translate(${endX}px, -50%)`;
    });

    setTimeout(() => {
        token.style.opacity = "0";
        setTimeout(() => token.remove(), 360);
    }, 1650);
}

function shouldHideEvent(data) {
    if (!data || !data.tag || !data.statusLabel) {
        return false;
    }

    const isPacket = data.tag.startsWith("PKT");
    const status = String(data.statusLabel).toUpperCase();
    return isPacket && (status === "SENT" || status === "IN FLIGHT");
}

function startLiveTimer() {
    stopLiveTimer();
    sessionStartMs = Date.now();
    updateLiveTimerText();
    timerIntervalId = setInterval(updateLiveTimerText, 100);
}

function stopLiveTimer() {
    if (timerIntervalId) {
        clearInterval(timerIntervalId);
        timerIntervalId = null;
    }
}

function updateLiveTimerText() {
    if (!sessionStartMs) {
        liveTimer.textContent = "🕒 00:00.0";
        return;
    }

    const elapsedMs = Date.now() - sessionStartMs;
    liveTimer.textContent = `🕒 ${formatElapsed(elapsedMs)}`;
}

function formatElapsed(ms) {
    const totalSeconds = ms / 1000;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.floor(totalSeconds % 60);
    const tenths = Math.floor((ms % 1000) / 100);
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
}

function formatEventTime() {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    const ms = String(now.getMilliseconds()).padStart(3, "0");
    const elapsed = sessionStartMs ? formatElapsed(Date.now() - sessionStartMs) : "00:00.0";
    return `${hh}:${mm}:${ss}.${ms} (${elapsed})`;
}