// LOC (League of Cubes) - 온라인 1:1 대전용 초경량 WebSocket 중계 서버
//
// 이 서버는 게임 로직을 전혀 알지 못한다. 하는 일은 딱 두 가지뿐이다:
//   1) 방 코드 생성/입장(매칭)
//   2) 매칭된 두 클라이언트 사이에서 'game' 메시지를 그대로 중계
// 실제 전투 계산(피해량, 이동 등)은 100% 클라이언트(각자의 브라우저)에서 이루어지고,
// 서버는 그 결과를 상대방에게 전달만 한다 - 친구끼리 하는 프로토타입이므로
// 서버 권위(anti-cheat) 없이 신뢰 기반으로 단순하게 구현했다.

const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;

// 방 코드에서 헷갈리기 쉬운 문자(0/O, 1/I/L)는 제외
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function generateRoomCode() {
  let code;
  do {
    code = "";
    for (let i = 0; i < 6; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  } while (rooms.has(code));
  return code;
}

// code -> { host: ws, guest: ws|null }
const rooms = new Map();

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (e) { /* 무시 */ }
  }
}

function getPeer(ws) {
  const room = ws._roomCode && rooms.get(ws._roomCode);
  if (!room) return null;
  if (room.host === ws) return room.guest;
  if (room.guest === ws) return room.host;
  return null;
}

function cleanupRoom(ws) {
  const code = ws._roomCode;
  if (!code) return;
  const room = rooms.get(code);
  if (!room) return;
  const peer = getPeer(ws);
  if (peer) {
    send(peer, { type: "opponentLeft" });
    peer._roomCode = null;
  }
  rooms.delete(code);
  ws._roomCode = null;
}

const server = http.createServer((req, res) => {
  // Render/Koyeb 등 호스팅의 헬스체크(핑) 및 사람이 실수로 URL을 열어봤을 때 안내
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("LOC relay server is running. Connect via WebSocket, not HTTP.");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws._roomCode = null;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    if (!msg || typeof msg.type !== "string") return;

    if (msg.type === "create") {
      if (ws._roomCode) return; // 이미 방을 만든 상태에서 중복 요청 무시
      const code = generateRoomCode();
      rooms.set(code, { host: ws, guest: null });
      ws._roomCode = code;
      send(ws, { type: "created", code });
      return;
    }

    if (msg.type === "join") {
      const code = String(msg.code || "").trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) { send(ws, { type: "error", message: "방을 찾을 수 없습니다. 코드를 확인해주세요." }); return; }
      if (room.guest) { send(ws, { type: "error", message: "이미 두 명이 입장한 방입니다." }); return; }
      if (room.host === ws) { send(ws, { type: "error", message: "자기 자신이 만든 방에는 입장할 수 없습니다." }); return; }
      room.guest = ws;
      ws._roomCode = code;
      send(room.host, { type: "matched" });
      send(room.guest, { type: "matched" });
      return;
    }

    if (msg.type === "game") {
      const peer = getPeer(ws);
      if (peer) send(peer, { type: "game", payload: msg.payload });
      return;
    }
  });

  ws.on("close", () => cleanupRoom(ws));
  ws.on("error", () => cleanupRoom(ws));
});

// 15초마다 죽은(응답 없는) 연결을 정리해서 매칭된 척 하는 유령 방이 남지 않도록 한다
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) { cleanupRoom(ws); return ws.terminate(); }
    ws.isAlive = false;
    ws.ping();
  });
}, 15000);
wss.on("close", () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`LOC relay server listening on port ${PORT}`);
});
