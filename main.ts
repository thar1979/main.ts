import { exists } from "https://deno.land/std/fs/exists.ts";

const CONFIG_FILE = 'config.json';
const credit = Deno.env.get('CREDIT') || 'DenoBy-ModsBots';

interface Config {
  uuid?: string;
}

/**
 * Reads the UUID from the config.json file.
 * @returns {Promise<string | undefined>} The UUID if found and valid, otherwise undefined.
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
      console.warn(`Error reading or parsing ${CONFIG_FILE}:`, (e as Error).message);
    }
  }
  return undefined;
}

/**
 * Saves the given UUID to the config.json file.
 * @param {string} uuid The UUID to save.
 */
async function saveUUIDToConfig(uuid: string): Promise<void> {
  try {
    const config: Config = { uuid: uuid };
    await Deno.writeTextFile(CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log(`Saved new UUID to ${CONFIG_FILE}: ${uuid}`);
  } catch (e) {
    console.error(`Failed to save UUID to ${CONFIG_FILE}:`, (e as Error).message);
  }
}

/**
 * Checks if a string is a valid UUID v4 format.
 * @param {string} uuid The UUID string to validate.
 * @returns {boolean} True if the string is a valid UUID, otherwise false.
 */
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Global variable to store the UUID
let userID: string;

// Initialize or load the UUID when the script starts
(async () => {
  const envUUID = Deno.env.get('UUID');
  if (envUUID && isValidUUID(envUUID)) {
    userID = envUUID;
    console.log(`Using UUID from environment: ${userID}`);
  } else {
    const configUUID = await getUUIDFromConfig();
    if (configUUID) {
      userID = configUUID;
    } else {
      userID = crypto.randomUUID();
      console.log(`Generated new UUID: ${userID}`);
      await saveUUIDToConfig(userID);
    }
  }

  if (!isValidUUID(userID)) {
    throw new Error('UUID is not valid.');
  }

  console.log(`Final UUID in use: ${userID}`);

  // Start the server after UUID is determined
  Deno.serve(async (request: Request) => {
    const url = new URL(request.url);
    const hostName = url.hostname;
    const port = url.port || (url.protocol === 'https:' ? 443 : 80);

    // VLESS URI for clients
    const vlessMain = `vless://${userID}@${hostName}:${port}?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2048#${credit}`;

    // Simple HTML content to display the VLESS URI
    const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>VLESS Config</title>
    <style>
        body { font-family: sans-serif; text-align: center; padding: 50px; background-color: #f4f4f4; }
        .container { background-color: white; padding: 20px; border-radius: 8px; box-shadow: 0 0 10px rgba(0, 0, 0, 0.1); display: inline-block; }
        pre { background-color: #eee; padding: 15px; border-radius: 5px; white-space: pre-wrap; word-break: break-all; }
        button { padding: 10px 20px; font-size: 16px; cursor: pointer; }
    </style>
</head>
<body>
    <div class="container">
        <h1>VLESS Configuration</h1>
        <p>Copy the VLESS URI below and use it in your client application:</p>
        <pre id="vless-uri">${vlessMain}</pre>
        <button onclick="copyToClipboard()">Copy to Clipboard</button>
        <p>This config uses the following UUID: ${userID}</p>
    </div>

    <script>
        function copyToClipboard() {
            const copyText = document.getElementById("vless-uri").innerText;
            navigator.clipboard.writeText(copyText)
                .then(() => alert("Copied to clipboard!"))
                .catch(err => console.error("Failed to copy: ", err));
        }
    </script>
</body>
</html>
    `;

    return new Response(htmlContent, {
      headers: { 'Content-Type': 'text/html' },
    });
  });
})();
