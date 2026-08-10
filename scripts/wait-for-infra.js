// Waits for the postgres + redis docker containers to report healthy before
// npm run infra:up returns, so the very next command (npm run dev) can rely
// on both services being reachable.
const { execSync } = require("child_process");

const containers = ["stateless-chat-postgres", "stateless-chat-redis"];
const timeoutMs = 60_000;
const start = Date.now();

function isHealthy(name) {
  try {
    const status = execSync(
      `docker inspect --format="{{.State.Health.Status}}" ${name}`,
      { stdio: ["ignore", "pipe", "ignore"] }
    )
      .toString()
      .trim();
    return status === "healthy";
  } catch {
    return false;
  }
}

function wait() {
  const allHealthy = containers.every(isHealthy);
  if (allHealthy) {
    console.log("infra: postgres + redis are healthy");
    return;
  }
  if (Date.now() - start > timeoutMs) {
    console.error("infra: timed out waiting for containers to become healthy");
    process.exit(1);
  }
  setTimeout(wait, 1000);
}

wait();
