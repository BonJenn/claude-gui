import { spawn } from "node:child_process";
import net from "node:net";

const START_PORT = 1420;
const END_PORT = 1520;

function canBind(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ port }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findPort() {
  for (let port = START_PORT; port <= END_PORT; port += 1) {
    if (await canBind(port)) return port;
  }
  throw new Error(`No free dev port found from ${START_PORT} to ${END_PORT}`);
}

const port = await findPort();
const config = JSON.stringify({
  build: {
    devUrl: `http://localhost:${port}`,
  },
});

console.log(`Blackcrab desktop dev server: http://localhost:${port}`);

const child = spawn(
  "npx",
  ["tauri", "dev", "--config", config, ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      BLACKCRAB_DEV_PORT: String(port),
    },
  },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
