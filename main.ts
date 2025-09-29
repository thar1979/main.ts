// main.ts - VLESS WebSocket Proxy Server
import { exists } from "https://deno.land/std/fs/exists.ts";

// Environment variables
const envUUID = Deno.env.get('UUID') || 'e5185305-1984-4084-81e0-f77271159c62';
const proxyIP = Deno.env.get('PROXYIP') || '';
const credit = Deno.env.get('CREDIT') || 'Deno-VLESS-Server';

const CONFIG_FILE = 'config.json';

interface Config {
  uuid?: string;
}

/**
 * UUID validation
 */
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
 * Read UUID from config file
 */
async function getUUIDFromConfig(): Promise<string | undefined> {
  if (await exists(CONFIG_FILE)) {
    try {
      const configText = await Deno.readTextFile(CONFIG_FILE);
      const config: Config = JSON.parse(configText);
      if (config.uuid && isValidUUID(config.uuid)) {
        console.log(`✅ Loaded UUID from config: ${config.uuid}`);
        return config.uuid;
      }
    } catch (e) {
      console.warn(`⚠️ Config error: ${e.message}`);
    }
  }
  return undefined;
}

/**
 * Save UUID to config file
 */
async function saveUUIDToConfig(uuid: string): Promise<void> {
  try {
    const config: Config = { uuid };
    await Deno.writeTextFile(CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log(`💾 Saved UUID to config: ${uuid}`);
  } catch (e) {
    console.error(`❌ Failed to save UUID: ${e.message}`);
  }
}

// Determine UUID to use
let userID: string;

if (envUUID && isValidUUID(envUUID)) {
  userID = envUUID;
  console.log(`🔑 Using UUID from environment: ${userID}`);
} else {
  const configUUID = await getUUIDFromConfig();
  if (configUUID) {
    userID = configUUID;
  } else {
    userID = crypto.randomUUID();
    console.log(`🎲 Generated new UUID: ${userID}`);
    await saveUUIDToConfig(userID);
  }
}

if (!isValidUUID(userID)) {
  throw new Error('❌ Invalid UUID format');
}

console.log(`🚀 Deno ${Deno.version.deno}`);
console.log(`🔑 Final UUID: ${userID}`);

// WebSocket states
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

/**
 * Safe WebSocket close
 */
function safeCloseWebSocket(socket: WebSocket): void {
  try {
    if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
      socket.close();
    }
  } catch (error) {
    console.error('WebSocket close error:', error);
  }
}

/**
 * Base64 to ArrayBuffer
 */
function base64ToArrayBuffer(base64Str: string): { earlyData?: ArrayBuffer; error?: Error } {
  if (!base64Str) return {};
  try {
    base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
    const decode = atob(base64Str);
    const arrayBuffer = Uint8Array.from(decode, c => c.charCodeAt(0));
    return { earlyData: arrayBuffer.buffer };
  } catch (error) {
    return { error };
  }
}

/**
 * UUID stringify from bytes
 */
function stringifyUUID(arr: Uint8Array, offset = 0): string {
  const byteToHex: string[] = [];
  for (let i = 0; i < 256; ++i) {
    byteToHex.push((i + 256).toString(16).slice(1));
  }
  
  const uuid = (
    byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] +
    byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + '-' +
    byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + '-' +
    byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + '-' +
    byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + '-' +
    byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] +
    byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] +
    byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]
  ).toLowerCase();
  
  if (!isValidUUID(uuid)) {
    throw new TypeError('Invalid UUID');
  }
  return uuid;
}

/**
 * Process VLESS header
 */
function processVlessHeader(
  vlessBuffer: ArrayBuffer, 
  userID: string
): {
  hasError: boolean;
  message?: string;
  addressRemote?: string;
  addressType?: number;
  portRemote?: number;
  rawDataIndex?: number;
  vlessVersion?: Uint8Array;
  isUDP?: boolean;
} {
  if (vlessBuffer.byteLength < 24) {
    return { hasError: true, message: 'Invalid data length' };
  }

  const version = new Uint8Array(vlessBuffer.slice(0, 1));
  const uuidBytes = new Uint8Array(vlessBuffer.slice(1, 17));
  
  if (stringifyUUID(uuidBytes) !== userID) {
    return { hasError: true, message: 'Invalid user' };
  }

  const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
  const command = new Uint8Array(vlessBuffer.slice(18 + optLength, 18 + optLength + 1))[0];

  let isUDP = false;
  if (command === 1) {
    // TCP
  } else if (command === 2) {
    isUDP = true;
  } else {
    return { hasError: true, message: `Unsupported command: ${command}` };
  }

  const portIndex = 18 + optLength + 1;
  const portBuffer = vlessBuffer.slice(portIndex, portIndex + 2);
  const portRemote = new DataView(portBuffer).getUint16(0);

  let addressIndex = portIndex + 2;
  const addressBuffer = new Uint8Array(vlessBuffer.slice(addressIndex, addressIndex + 1));
  const addressType = addressBuffer[0];
  
  let addressLength = 0;
  let addressValueIndex = addressIndex + 1;
  let addressValue = '';

  switch (addressType) {
    case 1: // IPv4
      addressLength = 4;
      addressValue = new Uint8Array(
        vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
      ).join('.');
      break;
    case 2: // Domain
      addressLength = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
      addressValueIndex += 1;
      addressValue = new TextDecoder().decode(
        vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
      );
      break;
    case 3: // IPv6
      addressLength = 16;
      const dataView = new DataView(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
      const ipv6: string[] = [];
      for (let i = 0; i < 8; i++) {
        ipv6.push(dataView.getUint16(i * 2).toString(16).padStart(4, '0'));
      }
      addressValue = ipv6.join(':');
      break;
    default:
      return { hasError: true, message: `Invalid address type: ${addressType}` };
  }

  if (!addressValue) {
    return { hasError: true, message: 'Empty address value' };
  }

  return {
    hasError: false,
    addressRemote: addressValue,
    addressType,
    portRemote,
    rawDataIndex: addressValueIndex + addressLength,
    vlessVersion: version,
    isUDP
  };
}

/**
 * Create readable WebSocket stream
 */
function makeReadableWebSocketStream(
  webSocketServer: WebSocket,
  earlyDataHeader: string,
  log: (info: string, event?: string) => void
): ReadableStream {
  let readableStreamCancel = false;

  return new ReadableStream({
    start(controller) {
      webSocketServer.addEventListener('message', (event) => {
        if (readableStreamCancel) return;
        controller.enqueue(event.data);
      });

      webSocketServer.addEventListener('close', () => {
        safeCloseWebSocket(webSocketServer);
        if (!readableStreamCancel) {
          controller.close();
        }
      });

      webSocketServer.addEventListener('error', (err) => {
        log('WebSocket error');
        controller.error(err);
      });

      const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
      if (error) {
        controller.error(error);
      } else if (earlyData) {
        controller.enqueue(earlyData);
      }
    },

    cancel(reason) {
      if (readableStreamCancel) return;
      log(`Stream canceled: ${reason}`);
      readableStreamCancel = true;
      safeCloseWebSocket(webSocketServer);
    }
  });
}

/**
 * Handle TCP outbound connections
 */
async function handleTCPOutBound(
  remoteSocket: { value: Deno.TcpConn | null },
  addressRemote: string,
  portRemote: number,
  rawClientData: Uint8Array,
  webSocket: WebSocket,
  vlessResponseHeader: Uint8Array,
  log: (info: string, event?: string) => void
): Promise<void> {
  async function connectAndWrite(address: string, port: number): Promise<Deno.TcpConn> {
    const tcpSocket = await Deno.connect({
      hostname: address,
      port: port
    });
    
    remoteSocket.value = tcpSocket;
    log(`Connected to ${address}:${port}`);
    
    const writer = tcpSocket.writable.getWriter();
    await writer.write(rawClientData);
    writer.releaseLock();
    
    return tcpSocket;
  }

  async function retry(): Promise<void> {
    const tcpSocket = await connectAndWrite(proxyIP || addressRemote, portRemote);
    remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null, log);
  }

  const tcpSocket = await connectAndWrite(addressRemote, portRemote);
  remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry, log);
}

/**
 * Forward remote socket to WebSocket
 */
async function remoteSocketToWS(
  remoteSocket: Deno.TcpConn,
  webSocket: WebSocket,
  vlessResponseHeader: Uint8Array,
  retry: (() => Promise<void>) | null,
  log: (info: string, event?: string) => void
): Promise<void> {
  let hasIncomingData = false;

  await remoteSocket.readable.pipeTo(
    new WritableStream({
      async write(chunk) {
        hasIncomingData = true;
        
        if (webSocket.readyState !== WS_READY_STATE_OPEN) {
          throw new Error('WebSocket not open');
        }

        if (vlessResponseHeader.length > 0) {
          const combined = new Uint8Array(vlessResponseHeader.length + chunk.length);
          combined.set(vlessResponseHeader);
          combined.set(chunk, vlessResponseHeader.length);
          webSocket.send(combined);
          vlessResponseHeader = new Uint8Array(0);
        } else {
          webSocket.send(chunk);
        }
      },
      
      close() {
        log(`Remote connection closed. Had data: ${hasIncomingData}`);
      },
      
      abort(reason) {
        log(`Remote connection aborted: ${reason}`);
      }
    })
  ).catch(error => {
    log(`Remote to WS error: ${error}`);
    safeCloseWebSocket(webSocket);
  });

  if (!hasIncomingData && retry) {
    log('Retrying connection...');
    retry();
  }
}

/**
 * Handle UDP outbound (DNS)
 */
async function handleUDPOutBound(
  webSocket: WebSocket,
  vlessResponseHeader: Uint8Array,
  log: (info: string) => void
): Promise<{ write: (chunk: Uint8Array) => void }> {
  let isVlessHeaderSent = false;

  const transformStream = new TransformStream({
    transform(chunk, controller) {
      for (let index = 0; index < chunk.byteLength;) {
        const lengthBuffer = chunk.slice(index, index + 2);
        const udpPacketLength = new DataView(lengthBuffer).getUint16(0);
        const udpData = new Uint8Array(
          chunk.slice(index + 2, index + 2 + udpPacketLength)
        );
        index = index + 2 + udpPacketLength;
        controller.enqueue(udpData);
      }
    }
  });

  transformStream.readable.pipeTo(
    new WritableStream({
      async write(chunk) {
        try {
          const resp = await fetch('https://1.1.1.1/dns-query', {
            method: 'POST',
            headers: {
              'content-type': 'application/dns-message',
            },
            body: chunk,
          });

          const dnsQueryResult = await resp.arrayBuffer();
          const udpSize = dnsQueryResult.byteLength;
          const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);

          if (webSocket.readyState === WS_READY_STATE_OPEN) {
            log(`DNS query successful, length: ${udpSize}`);
            
            if (isVlessHeaderSent) {
              webSocket.send(await new Blob([udpSizeBuffer, dnsQueryResult]).arrayBuffer());
            } else {
              webSocket.send(
                await new Blob([vlessResponseHeader, udpSizeBuffer, dnsQueryResult]).arrayBuffer()
              );
              isVlessHeaderSent = true;
            }
          }
        } catch (error) {
          log(`DNS query failed: ${error}`);
        }
      }
    })
  ).catch(error => {
    log(`DNS UDP error: ${error}`);
  });

  const writer = transformStream.writable.getWriter();

  return {
    write(chunk: Uint8Array) {
      writer.write(chunk);
    }
  };
}

/**
 * VLESS over WebSocket handler
 */
async function vlessOverWSHandler(request: Request): Promise<Response> {
  const { socket, response } = Deno.upgradeWebSocket(request);
  
  let address = '';
  let portWithRandomLog = '';
  
  const log = (info: string, event = '') => {
    console.log(`[${address}:${portWithRandomLog}] ${info}`, event);
  };

  const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
  const readableWebSocketStream = makeReadableWebSocketStream(socket, earlyDataHeader, log);
  
  let remoteSocketWrapper = { value: null as Deno.TcpConn | null };
  let udpStreamWrite: ((chunk: Uint8Array) => void) | null = null;
  let isDns = false;

  readableWebSocketStream.pipeTo(
    new WritableStream({
      async write(chunk) {
        if (isDns && udpStreamWrite) {
          return udpStreamWrite(new Uint8Array(chunk));
        }

        if (remoteSocketWrapper.value) {
          const writer = remoteSocketWrapper.value.writable.getWriter();
          await writer.write(new Uint8Array(chunk));
          writer.releaseLock();
          return;
        }

        const result = processVlessHeader(chunk, userID);
        
        if (result.hasError) {
          throw new Error(result.message);
        }

        const {
          portRemote = 443,
          addressRemote = '',
          rawDataIndex,
          vlessVersion = new Uint8Array([0, 0]),
          isUDP = false,
        } = result;

        address = addressRemote;
        portWithRandomLog = `${portRemote}--${Math.random()} ${isUDP ? 'udp ' : 'tcp '}`;

        if (isUDP) {
          if (portRemote === 53) {
            isDns = true;
          } else {
            throw new Error('UDP proxy only enabled for DNS (port 53)');
          }
        }

        const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
        const rawClientData = new Uint8Array(chunk.slice(rawDataIndex!));

        if (isDns) {
          const { write } = await handleUDPOutBound(socket, vlessResponseHeader, log);
          udpStreamWrite = write;
          udpStreamWrite(rawClientData);
          return;
        }

        handleTCPOutBound(
          remoteSocketWrapper,
          addressRemote!,
          portRemote,
          rawClientData,
          socket,
          vlessResponseHeader,
          log
        );
      },

      close() {
        log('WebSocket stream closed');
      },

      abort(reason) {
        log('WebSocket stream aborted', JSON.stringify(reason));
      }
    })
  ).catch(err => {
    log('Stream error', err);
  });

  return response;
}

/**
 * Generate beautiful HTML page
 */
function generateHTML(title: string, content: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            background: rgba(255, 255, 255, 0.95);
            border-radius: 20px;
            padding: 40px;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
            max-width: 600px;
            width: 100%;
            text-align: center;
        }
        h1 {
            color: #333;
            margin-bottom: 20px;
            font-size: 2.5em;
        }
        p {
            color: #666;
            margin-bottom: 30px;
            line-height: 1.6;
        }
        .btn {
            display: inline-block;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 15px 30px;
            border-radius: 50px;
            text-decoration: none;
            font-weight: 600;
            margin: 10px;
            transition: transform 0.3s ease;
        }
        .btn:hover {
            transform: translateY(-2px);
        }
        .config-box {
            background: #f8f9fa;
            border-radius: 10px;
            padding: 20px;
            margin: 20px 0;
            text-align: left;
            border-left: 4px solid #667eea;
        }
        .footer {
            margin-top: 30px;
            color: #888;
            font-size: 0.9em;
        }
    </style>
</head>
<body>
    <div class="container">
        ${content}
    </div>
</body>
</html>`;
}

/**
 * Main server
 */
Deno.serve(async (request: Request) => {
  const upgrade = request.headers.get('upgrade') || '';
  
  if (upgrade.toLowerCase() !== 'websocket') {
    const url = new URL(request.url);
    
    switch (url.pathname) {
      case '/': {
        const html = generateHTML('VLESS Server', `
            <h1>🚀 VLESS Server</h1>
            <p>Your VLESS over WebSocket proxy server is running successfully!</p>
            <div style="margin: 30px 0;">
                <div style="background: #e8f4fd; padding: 15px; border-radius: 10px; margin: 10px 0;">
                    <strong>UUID:</strong> <code>${userID}</code>
                </div>
                <div style="background: #e8f4fd; padding: 15px; border-radius: 10px; margin: 10px 0;">
                    <strong>Host:</strong> <code>${url.hostname}</code>
                </div>
            </div>
            <a href="/config" class="btn">📋 Get Configuration</a>
            <a href="/info" class="btn">ℹ️ Server Info</a>
            <div class="footer">
                Powered by Deno • ${credit}
            </div>
        `);
        return new Response(html, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }

      case '/config': {
        const hostName = request.headers.get('host') || url.hostname;
        const vlessURL = `vless://${userID}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=chrome&type=ws&host=${hostName}&path=%2F%3Fed%3D2048#${credit}`;
        
        const clashConfig = `- name: ${credit}
  type: vless
  server: ${hostName}
  port: 443
  uuid: ${userID}
  network: ws
  tls: true
  servername: ${hostName}
  ws-opts:
    path: "/?ed=2048"
    headers:
      Host: ${hostName}`;

        const html = generateHTML('VLESS Configuration', `
            <h1>📋 Configuration</h1>
            <p>Use these configurations in your client apps:</p>
            
            <div class="config-box">
                <h3>🔗 VLESS URL</h3>
                <code style="word-break: break-all; display: block;">${vlessURL}</code>
                <button onclick="copyText('${vlessURL}')" class="btn" style="padding: 8px 16px; margin-top: 10px;">Copy URL</button>
            </div>
            
            <div class="config-box">
                <h3>⚡ Clash Meta</h3>
                <pre style="background: #fff; padding: 15px; border-radius: 5px; overflow-x: auto;">${clashConfig}</pre>
                <button onclick="copyText(\`${clashConfig}\`)" class="btn" style="padding: 8px 16px; margin-top: 10px;">Copy Config</button>
            </div>
            
            <a href="/" class="btn">🏠 Home</a>
            
            <script>
                function copyText(text) {
                    navigator.clipboard.writeText(text).then(() => {
                        alert('Copied to clipboard!');
                    });
                }
            </script>
        `);
        return new Response(html, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }

      case '/info': {
        const html = generateHTML('Server Info', `
            <h1>ℹ️ Server Information</h1>
            <div class="config-box">
                <p><strong>UUID:</strong> ${userID}</p>
                <p><strong>Protocol:</strong> VLESS + WS + TLS</p>
                <p><strong>Port:</strong> 443 (WebSocket)</p>
                <p><strong>Path:</strong> /?ed=2048</p>
                <p><strong>Security:</strong> TLS</p>
                <p><strong>Fingerprint:</strong> Chrome</p>
            </div>
            <a href="/" class="btn">🏠 Home</a>
            <a href="/config" class="btn">📋 Get Config</a>
        `);
        return new Response(html, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }

      default:
        return new Response(generateHTML('404 Not Found', `
            <h1>❌ 404</h1>
            <p>Page not found</p>
            <a href="/" class="btn">Go Home</a>
        `), {
          status: 404,
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
    }
  } else {
    return await vlessOverWSHandler(request);
  }
});

console.log(`🚀 Server started at http://localhost:8000`);
console.log(`🔑 UUID: ${userID}`);
console.log(`💡 Visit http://localhost:8000 for configuration`);
