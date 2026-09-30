// What the journeys' monitors check: a server that answers as told.
// /ok answers 200, /slow answers 200 after a wait, /down answers 503.
import { createServer } from "node:http";

const PORT = 3224;

createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  if (path === "/slow") {
    setTimeout(() => res.end("slow"), 400);
  } else if (path === "/down") {
    res.statusCode = 503;
    res.end("down");
  } else {
    res.end("ok");
  }
}).listen(PORT, "127.0.0.1");
