import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { execSync } from "child_process";

const token = process.env.HETZNER_API_TOKEN!;

async function fixVM(serverId: number, serverName: string, ip: string) {
  // Reset root password via Hetzner API
  const resetRes = await fetch(
    `https://api.hetzner.cloud/v1/servers/${serverId}/actions/reset_password`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    }
  );
  const resetData = await resetRes.json();
  const rootPw = resetData.root_password;
  console.log(`${serverName} (${ip}): root pw reset, waiting...`);

  // Wait for password to propagate
  await new Promise((r) => setTimeout(r, 4000));

  // SSH as root with password and install missing libs
  try {
    const cmd = `sshpass -p '${rootPw}' ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 root@${ip} "DEBIAN_FRONTEND=noninteractive apt-get update -qq && apt-get install -y -qq libxkbcommon0 libcairo2 && echo PATCHED_OK"`;
    const result = execSync(cmd, { timeout: 60000, encoding: "utf8" });
    const lines = result.trim().split("\n");
    const last = lines[lines.length - 1];
    console.log(`  ${serverName}: ${last}`);
  } catch (e: any) {
    console.error(`  ${serverName}: FAILED - ${e.message?.split("\n")[0]}`);
  }
}

async function main() {
  // Check sshpass
  try {
    execSync("which sshpass", { encoding: "utf8" });
  } catch {
    console.log("Installing sshpass...");
    execSync("brew install hudochenkov/sshpass/sshpass", { stdio: "inherit" });
  }

  // Get all Hetzner servers
  const res = await fetch("https://api.hetzner.cloud/v1/servers?per_page=50", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();

  const vmNames = [
    "instaclaw-vm-17", "instaclaw-vm-18", "instaclaw-vm-19", "instaclaw-vm-20",
    "instaclaw-vm-21", "instaclaw-vm-22", "instaclaw-vm-23", "instaclaw-vm-24",
    "instaclaw-vm-25", "instaclaw-vm-26", "instaclaw-vm-27", "instaclaw-vm-28",
    "instaclaw-vm-29", "instaclaw-vm-30", "instaclaw-vm-31",
  ];

  for (const name of vmNames) {
    const server = data.servers.find((s: any) => s.name === name);
    if (!server) {
      console.log(`${name}: NOT FOUND on Hetzner`);
      continue;
    }
    await fixVM(server.id, name, server.public_net.ipv4.ip);
  }

  console.log("\nDone. Verifying VM-17...");

  // Verify browser works on VM-17
  try {
    const verifyCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=8 -i /tmp/ic_key openclaw@178.156.231.12 "ldd /home/openclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome 2>&1 | grep 'not found' || echo 'ALL_LIBS_OK'"`;
    const result = execSync(verifyCmd, { timeout: 15000, encoding: "utf8" });
    console.log("Verify:", result.trim());
  } catch (e: any) {
    console.error("Verify failed:", e.message?.split("\n")[0]);
  }
}

main();
