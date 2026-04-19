const dgram = require("dgram");
const server = dgram.createSocket("udp4");

server.on("message", (msg, rinfo) => {
    const packet = JSON.parse(msg.toString());

    console.log("Received:", packet);

    const ack = {
        type: "ACK",
        seq: packet.seq
    };

    server.send(JSON.stringify(ack), rinfo.port, rinfo.address);
});

server.bind(41234);