// main.ts
import { exists } from "https://deno.land/std@0.223.0/fs/exists.ts";

// Environment variables or defaults
const envUUID = Deno.env.get("UUID") || crypto.randomUUID();
const credit = Deno.env.get("CREDIT") || "Deno-VLESS";
const CONFIG_FILE = "config.json";

interface Config {
  uuid?: string;
}

/**
 * Validates UUID format.
 * @param uuid - The UUID to validate.
 * @returns True if valid, false otherwise.
 */
function isValidUUID(uuid: string): boolean {
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
 * Reads UUID from config.json.
 * @returns The UUID if found and valid, otherwise undefined.
 */
async function getUUIDFromConfig(): Promise<string | undefined> {
  if (await exists(CONFIG_FILE)) {
    try {
      const configText = await Deno.readTextFile(CONFIG_FILE);
      const config: Config = JSON.parse(configText);
      if (config.uuid && isValidUUID(config.uuid)) {
        console.log(`Loaded UUID from ${CONFIG_FILE}: ${config.uuid}`);
        return config.uuid;
      }
    } catch (e) {
      console.warn(`Error reading ${CONFIG_FILE}:`, e.message);
    }
  }
  return undefined;
}

/**
 * Saves UUID to config.json.
 * @param uuid - The UUID to save.
 */
async function saveUUIDToConfig(uuid: string): Promise<void> {
  try {
    const config: Config = { uuid };
    await Deno.writeTextFile(CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log(`Saved UUID to ${CONFIG_FILE}: ${uuid}`);
  } catch (e) {
    console.error(`Failed to save UUID to ${CONFIG_FILE}:`, e.message);
  }
}

// Initialize UUID
let userID: string;
(async () => {
  if (envUUID && isValidUUID(envUUID)) {
    userID = envUUID;
    console.log(`Using UUID from environment: ${userID}`);
  } else {
    const configUUID = await getUUIDFromConfig();
    userID = configUUID || crypto.randomUUID();
    console.log(`Using UUID: ${userID}`);
    if (!configUUID) await saveUUIDToConfig(userID);
  }

  if (!isValidUUID(userID)) {
    throw new Error("Invalid UUID");
  }
})();

// HTTP and WebSocket server
Deno.serve({ port: 8000 }, async (request: Request) => {
  const url = new URL(request.url);
  const upgrade = request.headers.get("upgrade") || "";

  // Handle WebSocket connections
  if (upgrade.toLowerCase() === "websocket") {
    return await handleWebSocket(request, userID);
  }

  // Handle HTTP requests
  switch (url.pathname) {
    case "/": {
      const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Deno VLESS Proxy</title>
  <style>
    body { font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background-color: #f4f4f4; }
    .container { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 0 10px rgba(0,0,0,0.1); text-align: center; }
    h1 { color: #333; }
    .button { display: inline-block; padding: 10px 20px; background: #007bff; color: white; text-decoration: none; border-radius: 5px; }
    .button:hover { background: #0056b3; }
    .footer { margin-top: 20px; font-size: 0.9em; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🚀 Deno VLESS Proxy</h1>
    <p>Secure VLESS over WebSocket proxy is running!</p>
    <a href="/${userID}" class="button">Get VLESS Config</a>
    <div class="footer">Powered by Deno | Credit: ${credit}</div>
  </div>
</body>
</html>
      `;
      return new Response(htmlContent, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    case `/${userID}`: {
      const hostName = url.hostname;
      const port = url.port || (url.protocol === "https:" ? 443 : 80);
      const vlessURI = `vless://${userID}@${hostName}:${port}?encryption=none&security=tls&sni=${hostName}&type=ws&host=${hostName}&path=%2F#${credit}`;
      const clashMetaConfig = `
- type: vless
  name: ${hostName}
  server: ${hostName}
  port: ${port}
  uuid: ${userID}
  network: ws
  tls: true
  sni: ${hostName}
  ws-opts:
    path: "/"
    headers:
      host: ${hostName}
      `;

      const htmlConfigContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>VLESS Configuration</title>
  <style>
    body { font-family: Arial, sans-serif; display: flex; flex-direction: column; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f4f4f4; padding: 20px; }
    .container { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 0 10px rgba(0,0,0,0.1); max-width: 600px; width: 100%; }
    h1 { color: #333; }
    h2 { color: #555; margin-top: 20px; }
    .config-block { background: #f8f9fa; padding: 15px; border-left: 4px solid #007bff; border-radius: 5px; position: relative; }
    pre { white-space: pre-wrap; word-wrap: break-word; font-family: monospace; font-size: 0.9em; }
    .copy-button { position: absolute; top: 10px; right: 10px; background: #28a745; color: white; border: none; padding: 5px 10px; border-radius: 3px; cursor: pointer; }
    .copy-button:hover { background: #218838; }
    .footer { margin-top: 20px; font-size: 0.9em; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🔑 VLESS Configuration</h1>
    <p>Copy the configurations below for your VLESS client.</p>
    <h2>VLESS URI</h2>
    <div class="config-block">
      <pre id="vless-uri">${vlessURI}</pre>
      <button class="copy-button" onclick="copyToClipboard('vless-uri')">Copy</button>
    </div>
    <h2>Clash-Meta Config</h2>
    <div class="config-block">
      <pre id="clash-meta">${clashMetaConfig.trim()}</pre>
      <button class="copy-button" onclick="copyToClipboard('clash-meta')">Copy</button>
    </div>
  </div>
  <script>
    function copyToClipboard(id) {
      const text = document.getElementById(id).innerText;
      navigator.clipboard.writeText(text).then(() => alert("Copied to clipboard!")).catch(() => alert("Failed to copy."));
    }
  </script>
  <div class="footer">Powered by Deno | Credit: ${credit}</div>
</body>
</html>
      `;
      return new Response(htmlConfigContent, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    default:
      return new Response("Not found", { status: 404 });
  }
});

/**
 * Handles WebSocket connections for VLESS.
 * @param request - The incoming request.
 * @param userID - The UUID for VLESS.
 * @returns WebSocket response.
 */
async function handleWebSocket(request: Request, userID: string) {
  const { socket, response } = Deno.upgradeWebSocket(request);

  socket.onmessage = async (event) => {
    const data = new Uint8Array(await event.data.arrayBuffer());
    const { hasError, message, addressRemote, portRemote, rawDataIndex } =
      processVlessHeader(data, userID);

    if (hasError) {
      socket.close(1000, message);
      return;
    }

    try {
      const tcpSocket = await Deno.connect({
        hostname: addressRemote || "1.1.1.1",
        port: portRemote || 80,
      });
      const writer = tcpSocket.writable.getWriter();
      await writer.write(data.slice(rawDataIndex));
      writer.releaseLock();

      tcpSocket.readable.pipeTo(
        new WritableStream({
          write(chunk) {
            if (socket.readyState === 1) socket.send(chunk);
          },
        }),
      );
    } catch (e) {
      console.error("TCP connection error:", e.message);
      socket.close(1000, "Connection error");
    }
  };

  socket.onclose = () => console.log("WebSocket closed");
  socket.onerror = (e) => console.error("WebSocket error:", e);

  return response;
}

/**
 * Processes VLESS header to extract address and port.
 * @param buffer - The incoming data buffer.
 * @param userID - The expected UUID.
 * @returns Parsed header information.
 */
function processVlessHeader(buffer: ArrayBuffer, userID: string) {
  if (buffer.byteLength < 24) {
    return { hasError: true, message: "Invalid data" };
  }

  const version = new Uint8Array(buffer.slice(0, 1));
  const uuidBytes = new Uint8Array(buffer.slice(1, 17));
  const uuid = unsafeStringify(uuidBytes);
  if (uuid !== userID) {
    return { hasError: true, message: "Invalid user" };
  }

  const optLength = new Uint8Array(buffer.slice(17, 18))[0];
  const command = new Uint8Array(buffer.slice(18 + optLength, 19 + optLength))[0];
  if (command !== 1) {
    return { hasError: true, message: "Only TCP supported" };
  }

  const portIndex = 19 + optLength;
  const port = new DataView(buffer.slice(portIndex, portIndex + 2)).getUint16(0);
  const addressType = new Uint8Array(buffer.slice(portIndex + 2, portIndex + 3))[0];
  let address = "";
  let addressLength = 0;
  let addressIndex = portIndex + 3;

  switch (addressType) {
    case 1: // IPv4
      addressLength = 4;
      address = new Uint8Array(buffer.slice(addressIndex, addressIndex + 4)).join(".");
      break;
    case 2: // Domain
      addressLength = new Uint8Array(buffer.slice(addressIndex, addressIndex + 1))[0];
      address = new TextDecoder().decode(
        buffer.slice(addressIndex + 1, addressIndex + 1 + addressLength),
      );
      break;
    case 3: // IPv6
      addressLength = 16;
      const ipv6: string[] = [];
      for (let i = 0; i < 8; i++) {
        ipv6.push(
          new DataView(buffer.slice(addressIndex, addressIndex + 16)).getUint16(i * 2).toString(16),
        );
      }
      address = ipv6.join(":");
      break;
    default:
      return { hasError: true, message: `Invalid address type: ${addressType}` };
  }

  return {
    hasError: false,
    addressRemote: address,
    portRemote: port,
    rawDataIndex: addressIndex + addressLength,
    vlessVersion: version,
  };
}

/**
 * Converts byte array to UUID string.
 * @param arr - Byte array.
 * @returns UUID string.
 */
function unsafeStringify(arr: Uint8Array): string {
  const byteToHex: string[] = [];
  for (let i = 0; i < 256; ++i) {
    byteToHex.push((i + 256).toString(16).slice(1));
  }
  return (
    byteToHex[arr[0]] +
    byteToHex[arr[1]] +
    byteToHex[arr[2]] +
    byteToHex[arr[3]] +
    "-" +
    byteToHex[arr[4]] +
    byteToHex[arr[5]] +
    "-" +
    byteToHex[arr[6]] +
    byteToHex[arr[7]] +
    "-" +
    byteToHex[arr[8]] +
    byteToHex[arr[9]] +
    "-" +
    byteToHex[arr[10]] +
    byteToHex[arr[11]] +
    byteToHex[arr[12]] +
    byteToHex[arr[13]] +
    byteToHex[arr[14]] +
    byteToHex[arr[15]]
  ).toLowerCase();
}
