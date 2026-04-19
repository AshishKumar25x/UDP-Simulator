const dgram = require("dgram");
const client = dgram.createSocket("udp4");

function sendPacket(seq) {
    const packet = {
        type: "DATA",
        seq: seq,
        data: "Hello " + seq
    };

    client.send(JSON.stringify(packet), 41234, "localhost");
}

module.exports = { sendPacket };