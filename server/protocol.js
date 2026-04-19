const dgram = require("dgram");
const client = dgram.createSocket("udp4");

let windowSize = 4;
let base = 0;
let nextSeq = 0;
let timer = null;

function startSending(ws) {
    sendWindow(ws);
}

function sendWindow(ws) {
    while (nextSeq < base + windowSize) {
        sendPacket(nextSeq, ws);
        nextSeq++;
    }
}

function sendPacket(seq, ws) {
    const packet = { type: "DATA", seq };

    client.send(JSON.stringify(packet), 41234, "localhost");

    ws.send(JSON.stringify({
        event: "send",
        seq
    }));

    startTimer(seq, ws);
}

function startTimer(seq, ws) {
    setTimeout(() => {
        ws.send(JSON.stringify({
            event: "timeout",
            seq
        }));

        sendPacket(seq, ws); // retransmit
    }, 2000);
}

module.exports = { startSending };