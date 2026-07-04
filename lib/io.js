const { Server } = require("socket.io");

// Holder for the single Socket.IO server instance. index.js calls init() once
// after the HTTP server is created; every other module reads the live instance
// via getIO() at call time (never at module load), so ordering is not an issue.
let io = null;

function init(httpServer) {
  io = new Server(httpServer, { cors: { origin: "*" } });
  return io;
}

function getIO() {
  if (!io) throw new Error("Socket.IO not initialised — call init() first");
  return io;
}

module.exports = { init, getIO };
