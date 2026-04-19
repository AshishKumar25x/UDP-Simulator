const WebSocket = require("ws");

const http = require("http");

const server = http.createServer();
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 8080;

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
console.log(`WebSocket server running on port ${PORT}`);

const WAIT_MS = 500;
const STOPWAIT_TIMEOUT_MS = 1600;
const LOSS_RATE_DATA = 0.28;
const LOSS_RATE_ACK = 0.22;
const WINDOW_SIZE = 4;

wss.on("connection", (ws) => {
    console.log("Client connected");

    const session = { stopped: false, runId: 0 };

    ws.on("message", async (raw) => {
        let data;
        try {
            data = JSON.parse(raw.toString());
        } catch {
            return;
        }

        if (data.action === "stop") {
            session.stopped = true;
            session.runId += 1;
            return;
        }

        if (data.action === "start") {
            session.stopped = false;
            session.runId += 1;
            const runId = session.runId;
            const protocol = normalizeProtocol(data.protocol);
            const message = String(data.message || "Hello Reliable UDP");
            const packets = chunkMessage(message, 5);

            send(ws, {
                event: "reset",
                protocolName: protocolLabel(protocol)
            });

            try {
                if (protocol === "stopwait") {
                    await simulateStopAndWait(ws, session, runId, packets);
                } else if (protocol === "gobackn") {
                    await simulateGoBackN(ws, session, runId, packets);
                } else {
                    await simulateSelectiveRepeat(ws, session, runId, packets);
                }
            } catch {
                return;
            }

            if (!isStopped(session, runId)) {
                send(ws, { event: "done", protocolName: protocolLabel(protocol) });
            }
        }
    });
});

async function simulateStopAndWait(ws, session, runId, packets) {
    for (let i = 0; i < packets.length; i += 1) {
        let acked = false;
        let attempt = 1;

        while (!acked && !isStopped(session, runId)) {
            log(ws, {
                tag: `PKT ${i}`,
                text: `Sender -> Receiver data "${packets[i]}" (attempt ${attempt})`,
                status: "warn",
                statusLabel: "SENT",
                senderState: `Waiting ACK ${i}`,
                receiverState: "Receiving data"
            });
            await wait();
            guard(session, runId);

            const dataLost = randomLoss(LOSS_RATE_DATA);
            if (dataLost) {
                log(ws, {
                    tag: `PKT ${i}`,
                    text: `Packet ${i} lost in channel. Sender starts timeout (${STOPWAIT_TIMEOUT_MS}ms)`,
                    status: "bad",
                    statusLabel: "DATA LOST",
                    senderState: `Timer running for ${i}`,
                    receiverState: "No packet arrived"
                });
                await waitMs(STOPWAIT_TIMEOUT_MS);
                guard(session, runId);
                log(ws, {
                    tag: `PKT ${i}`,
                    text: `Timeout expired for packet ${i}, retransmitting`,
                    status: "warn",
                    statusLabel: "TIMEOUT",
                    senderState: `Resending ${i}`,
                    receiverState: "Waiting retransmit"
                });
                await wait();
                attempt += 1;
                continue;
            }

            log(ws, {
                tag: `PKT ${i}`,
                text: `Receiver got packet ${i}, sending ACK ${i}`,
                status: "ok",
                statusLabel: "RECEIVED",
                senderState: `Waiting ACK ${i}`,
                receiverState: `ACK ${i} sent`
            });
            await wait();
            guard(session, runId);

            const ackLost = randomLoss(LOSS_RATE_ACK);
            if (ackLost) {
                log(ws, {
                    tag: `ACK ${i}`,
                    text: `ACK ${i} lost. Sender waits for timeout (${STOPWAIT_TIMEOUT_MS}ms)`,
                    status: "bad",
                    statusLabel: "ACK LOST",
                    senderState: `ACK timer running ${i}`,
                    receiverState: "Duplicate-safe mode"
                });
                await waitMs(STOPWAIT_TIMEOUT_MS);
                guard(session, runId);
                log(ws, {
                    tag: `PKT ${i}`,
                    text: `ACK timeout for ${i}, retransmitting same packet`,
                    status: "warn",
                    statusLabel: "TIMEOUT",
                    senderState: `Resending ${i}`,
                    receiverState: "Duplicate-safe mode"
                });
                await wait();
                attempt += 1;
                continue;
            }

            log(ws, {
                tag: `ACK ${i}`,
                text: `Sender received ACK ${i}, moving to next packet`,
                status: "ok",
                statusLabel: "ACKED",
                senderState: `Packet ${i} complete`,
                receiverState: "Ready for next"
            });
            await wait();
            acked = true;
        }
    }
}

async function simulateGoBackN(ws, session, runId, packets) {
    let base = 0;
    let nextSeq = 0;

    while (base < packets.length && !isStopped(session, runId)) {
        while (nextSeq < base + WINDOW_SIZE && nextSeq < packets.length) {
            log(ws, {
                tag: `PKT ${nextSeq}`,
                text: `Send window packet ${nextSeq} "${packets[nextSeq]}"`,
                status: "warn",
                statusLabel: "IN FLIGHT",
                senderState: `Window base=${base}`,
                receiverState: "Receiving window"
            });
            await wait();
            guard(session, runId);
            nextSeq += 1;
        }

        let ackTarget = base;
        let failureAt = -1;
        for (let i = base; i < nextSeq; i += 1) {
            const dataLost = randomLoss(LOSS_RATE_DATA);
            if (dataLost) {
                failureAt = i;
                break;
            }
            ackTarget = i + 1;
        }

        if (failureAt !== -1) {
            if (ackTarget > base) {
                log(ws, {
                    tag: `ACK ${ackTarget - 1}`,
                    text: `Cumulative ACK received up to ${ackTarget - 1}; base slides to ${ackTarget}`,
                    status: "ok",
                    statusLabel: "PARTIAL ACK",
                    senderState: `Slide to ${ackTarget}`,
                    receiverState: "Accepted in-order prefix"
                });
                await wait();
                guard(session, runId);
                base = ackTarget;
            }

            log(ws, {
                tag: `PKT ${failureAt}`,
                text: `Packet ${failureAt} lost. Go-Back-N retransmits from ${base}`,
                status: "bad",
                statusLabel: "WINDOW RETRY",
                senderState: `Resend from ${base}`,
                receiverState: `Missing from ${failureAt}`
            });
            await wait();
            nextSeq = base;
            continue;
        }

        const ackLost = randomLoss(LOSS_RATE_ACK);
        if (ackLost) {
            log(ws, {
                tag: `ACK ${ackTarget - 1}`,
                text: `Cumulative ACK lost. Timeout at base ${base}; resend whole window`,
                status: "bad",
                statusLabel: "ACK LOST",
                senderState: `Timeout base ${base}`,
                receiverState: "Already received"
            });
            await wait();
            nextSeq = base;
            continue;
        }

        log(ws, {
            tag: `ACK ${ackTarget - 1}`,
            text: `Cumulative ACK received up to ${ackTarget - 1}`,
            status: "ok",
            statusLabel: "WINDOW ACKED",
            senderState: `Slide to ${ackTarget}`,
            receiverState: "In-order accepted"
        });
        await wait();
        base = ackTarget;
    }
}

async function simulateSelectiveRepeat(ws, session, runId, packets) {
    const acked = Array.from({ length: packets.length }, () => false);

    while (acked.some((item) => !item) && !isStopped(session, runId)) {
        for (let i = 0; i < packets.length; i += 1) {
            if (acked[i]) {
                continue;
            }

            log(ws, {
                tag: `PKT ${i}`,
                text: `Send packet ${i} "${packets[i]}" (independent timer)`,
                status: "warn",
                statusLabel: "SENT",
                senderState: `Tracking packet ${i}`,
                receiverState: "Buffering out-of-order allowed"
            });
            await wait();
            guard(session, runId);

            if (randomLoss(LOSS_RATE_DATA)) {
                log(ws, {
                    tag: `PKT ${i}`,
                    text: `Packet ${i} lost. Only packet ${i} will be retransmitted`,
                    status: "bad",
                    statusLabel: "DATA LOST",
                    senderState: `Retry only ${i}`,
                    receiverState: "Missing one packet"
                });
                await wait();
                continue;
            }

            log(ws, {
                tag: `PKT ${i}`,
                text: `Receiver got packet ${i}; packet buffered/delivered`,
                status: "ok",
                statusLabel: "RECEIVED",
                senderState: `Waiting ACK ${i}`,
                receiverState: `Data ${i} received`
            });
            await wait();
            guard(session, runId);

            if (randomLoss(LOSS_RATE_ACK)) {
                log(ws, {
                    tag: `ACK ${i}`,
                    text: `ACK ${i} lost. Sender retries only packet ${i}`,
                    status: "bad",
                    statusLabel: "ACK LOST",
                    senderState: `ACK timeout ${i}`,
                    receiverState: "Packet buffered"
                });
                await wait();
                continue;
            }

            acked[i] = true;
            log(ws, {
                tag: `ACK ${i}`,
                text: `ACK ${i} received. Packet ${i} confirmed`,
                status: "ok",
                statusLabel: "ACKED",
                senderState: `Confirmed ${i}`,
                receiverState: "Delivered/Buffered"
            });
            await wait();
        }
    }
}

function send(ws, payload) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
    }
}

function log(ws, payload) {
    send(ws, { event: "log", ...payload });
}

function wait() {
    return new Promise((resolve) => setTimeout(resolve, WAIT_MS));
}

function waitMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomLoss(rate) {
    return Math.random() < rate;
}

function chunkMessage(message, size) {
    const out = [];
    for (let i = 0; i < message.length; i += size) {
        out.push(message.slice(i, i + size));
    }
    return out.length ? out : ["EMPTY"];
}

function normalizeProtocol(protocol) {
    if (protocol === "gobackn" || protocol === "selectiverepeat" || protocol === "stopwait") {
        return protocol;
    }
    return "stopwait";
}

function protocolLabel(protocol) {
    if (protocol === "gobackn") {
        return "Go-Back-N";
    }
    if (protocol === "selectiverepeat") {
        return "Selective Repeat";
    }
    return "Stop-and-Wait";
}

function isStopped(session, runId) {
    return session.stopped || session.runId !== runId;
}

function guard(session, runId) {
    if (isStopped(session, runId)) {
        throw new Error("Simulation stopped");
    }
}