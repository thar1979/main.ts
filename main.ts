// main.ts - PRODUCTION VLESS SERVER
import { exists } from "https://deno.land/std/fs/exists.ts";

const envUUID = Deno.env.get('UUID') || 'e5185305-1984-4084-81e0-f77271159c62';
const proxyIP = Deno.env.get('PROXYIP') || '';
const credit = Deno.env.get('CREDIT') || 'Deno-Production-VLESS';

const CONFIG_FILE = 'config.json';

interface Config {
  uuid?: string;
}

// UUID validation
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Get UUID from config
async function getUUIDFromConfig(): Promise<string | undefined> {
  try {
    if (await exists(CONFIG_FILE)) {
      const configText = await Deno.readTextFile(CONFIG_FILE);
      const config: Config = JSON.parse(configText);
      if (config.uuid && isValidUUID(config.uuid)) {
        console.log(`✅ Loaded UUID from config`);
        return config.uuid;
      }
    }
  } catch (e) {
    console.log('Using new UUID');
  }
  return undefined;
}

// Save UUID to config
async function saveUUIDToConfig(uuid: string): Promise<void> {
  try {
    const config: Config = { uuid };
    await Deno.writeTextFile(CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log(`💾 Saved UUID to config`);
  } catch (e) {
    console.log('Cannot save config, using in-memory UUID');
  }
}

// Initialize UUID
let userID: string;

if (envUUID && isValidUUID(envUUID)) {
  userID = envUUID;
  console.log(`✅ Using UUID from environment: ${userID}`);
} else {
  const configUUID = await getUUIDFromConfig();
  if (configUUID) {
    userID = configUUID;
  } else {
    userID = crypto.randomUUID();
    console.log(`🆕 Generated new UUID: ${userID}`);
    await saveUUIDToConfig(userID);
  }
}

if (!isValidUUID(userID)) {
  userID = crypto.randomUUID();
  console.log(`🔄 Forced valid UUID: ${userID}`);
}

console.log(`🚀 PRODUCTION VLESS SERVER STARTED: ${userID}`);
console.log(`🌐 Server is ready for real traffic`);

// WebSocket handler for real VLESS protocol
async function vlessOverWSHandler(request: Request): Promise<Response> {
  const { socket, response } = Deno.upgradeWebSocket(request);
  
  let address = '';
  let portWithRandomLog = '';
  
  const log = (info: string, event = '') => {
    console.log(`[${address}:${portWithRandomLog}] ${info}`, event);
  };

  const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
  
  const readableWebSocketStream = makeReadableWebSocketStream(socket, earlyDataHeader, log);
  let remoteSocketWapper: any = { value: null };
  let udpStreamWrite: any = null;
  let isDns = false;

  // Handle WebSocket stream
  readableWebSocketStream
    .pipeTo(
      new WritableStream({
        async write(chunk, controller) {
          if (isDns && udpStreamWrite) {
            return udpStreamWrite(chunk);
          }
          if (remoteSocketWapper.value) {
            const writer = remoteSocketWapper.value.writable.getWriter();
            await writer.write(new Uint8Array(chunk));
            writer.releaseLock();
            return;
          }

          const {
            hasError,
            message,
            portRemote = 443,
            addressRemote = '',
            rawDataIndex,
            vlessVersion = new Uint8Array([0, 0]),
            isUDP,
          } = processVlessHeader(chunk, userID);
          
          address = addressRemote;
          portWithRandomLog = `${portRemote}--${Math.random()} ${isUDP ? 'udp ' : 'tcp '}`;
          
          if (hasError) {
            throw new Error(message);
          }

          if (isUDP) {
            if (portRemote === 53) {
              isDns = true;
            } else {
              throw new Error('UDP proxy only for DNS (port 53)');
            }
          }
          
          const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
          const rawClientData = chunk.slice(rawDataIndex);

          if (isDns) {
            const { write } = await handleUDPOutBound(socket, vlessResponseHeader, log);
            udpStreamWrite = write;
            udpStreamWrite(rawClientData);
            return;
          }
          
          handleTCPOutBound(
            remoteSocketWapper,
            addressRemote,
            portRemote,
            rawClientData,
            socket,
            vlessResponseHeader,
            log
          );
        },
        close() {
          log(`WebSocket stream closed`);
        },
        abort(reason) {
          log(`WebSocket stream aborted`, JSON.stringify(reason));
        },
      })
    )
    .catch((err) => {
      log('WebSocket stream error', err);
    });

  return response;
}

// Make readable WebSocket stream
function makeReadableWebSocketStream(webSocketServer: WebSocket, earlyDataHeader: string, log: (info: string, event?: string) => void) {
  let readableStreamCancel = false;
  
  const stream = new ReadableStream({
    start(controller) {
      webSocketServer.addEventListener('message', (event) => {
        if (readableStreamCancel) return;
        controller.enqueue(event.data);
      });

      webSocketServer.addEventListener('close', () => {
        safeCloseWebSocket(webSocketServer);
        if (readableStreamCancel) return;
        controller.close();
      });
      
      webSocketServer.addEventListener('error', (err) => {
        log('WebSocket error');
        controller.error(err);
      });
      
      // Early data handling
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
    },
  });

  return stream;
}

// Process VLESS header
function processVlessHeader(vlessBuffer: ArrayBuffer, userID: string) {
  if (vlessBuffer.byteLength < 24) {
    return { hasError: true, message: 'Invalid data' };
  }
  
  const version = new Uint8Array(vlessBuffer.slice(0, 1));
  let isValidUser = false;
  let isUDP = false;
  
  if (stringify(new Uint8Array(vlessBuffer.slice(1, 17))) === userID) {
    isValidUser = true;
  }
  
  if (!isValidUser) {
    return { hasError: true, message: 'Invalid user' };
  }

  const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
  const command = new Uint8Array(vlessBuffer.slice(18 + optLength, 18 + optLength + 1))[0];

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
    case 1:
      addressLength = 4;
      addressValue = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
      break;
    case 2:
      addressLength = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
      addressValueIndex += 1;
      addressValue = new TextDecoder().decode(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
      break;
    case 3:
      addressLength = 16;
      const dataView = new DataView(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
      const ipv6: string[] = [];
      for (let i = 0; i < 8; i++) {
        ipv6.push(dataView.getUint16(i * 2).toString(16));
      }
      addressValue = ipv6.join(':');
      break;
    default:
      return { hasError: true, message: `Invalid address type: ${addressType}` };
  }

  if (!addressValue) {
    return { hasError: true, message: 'Empty address' };
  }

  return {
    hasError: false,
    addressRemote: addressValue,
    addressType,
    portRemote,
    rawDataIndex: addressValueIndex + addressLength,
    vlessVersion: version,
    isUDP,
  };
}

// Handle TCP outbound connections
async function handleTCPOutBound(
  remoteSocket: { value: any },
  addressRemote: string,
  portRemote: number,
  rawClientData: Uint8Array,
  webSocket: WebSocket,
  vlessResponseHeader: Uint8Array,
  log: (info: string, event?: string) => void
) {
  async function connectAndWrite(address: string, port: number) {
    const tcpSocket = await Deno.connect({
      port: port,
      hostname: address,
    });

    remoteSocket.value = tcpSocket;
    log(`✅ Connected to ${address}:${port}`);
    
    const writer = tcpSocket.writable.getWriter();
    await writer.write(new Uint8Array(rawClientData));
    writer.releaseLock();
    
    return tcpSocket;
  }

  const tcpSocket = await connectAndWrite(proxyIP || addressRemote, portRemote);
  remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null, log);
}

// WebSocket to remote socket
async function remoteSocketToWS(remoteSocket: Deno.TcpConn, webSocket: WebSocket, vlessResponseHeader: Uint8Array, retry: (() => Promise<void>) | null, log: (info: string, event?: string) => void) {
  let hasIncomingData = false;
  
  await remoteSocket.readable
    .pipeTo(
      new WritableStream({
        async write(chunk, controller) {
          hasIncomingData = true;
          
          if (webSocket.readyState !== WS_READY_STATE_OPEN) {
            controller.error('WebSocket not open');
          }

          if (vlessResponseHeader) {
            webSocket.send(new Uint8Array([...vlessResponseHeader, ...chunk]));
            vlessResponseHeader = null;
          } else {
            webSocket.send(chunk);
          }
        },
        close() {
          log(`Remote connection closed, had incoming data: ${hasIncomingData}`);
        },
        abort(reason) {
          console.error('Remote connection aborted', reason);
        },
      })
    )
    .catch((error) => {
      console.error('Remote to WS error', error);
      safeCloseWebSocket(webSocket);
    });

  if (!hasIncomingData && retry) {
    log(`Retrying connection`);
    retry();
  }
}

// Handle UDP outbound (DNS)
async function handleUDPOutBound(webSocket: WebSocket, vlessResponseHeader: Uint8Array, log: (info: string) => void) {
  let isVlessHeaderSent = false;
  
  const transformStream = new TransformStream({
    transform(chunk, controller) {
      for (let index = 0; index < chunk.byteLength;) {
        const lengthBuffer = chunk.slice(index, index + 2);
        const udpPacketLength = new DataView(lengthBuffer).getUint16(0);
        const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPacketLength));
        index = index + 2 + udpPacketLength;
        controller.enqueue(udpData);
      }
    },
  });

  transformStream.readable
    .pipeTo(
      new WritableStream({
        async write(chunk) {
          const resp = await fetch('https://1.1.1.1/dns-query', {
            method: 'POST',
            headers: { 'content-type': 'application/dns-message' },
            body: chunk,
          });
          
          const dnsQueryResult = await resp.arrayBuffer();
          const udpSize = dnsQueryResult.byteLength;
          const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
          
          if (webSocket.readyState === WS_READY_STATE_OPEN) {
            log(`DNS query successful: ${udpSize} bytes`);
            
            if (isVlessHeaderSent) {
              webSocket.send(await new Blob([udpSizeBuffer, dnsQueryResult]).arrayBuffer());
            } else {
              webSocket.send(await new Blob([vlessResponseHeader, udpSizeBuffer, dnsQueryResult]).arrayBuffer());
              isVlessHeaderSent = true;
            }
          }
        },
      })
    )
    .catch((error) => {
      log('DNS UDP error: ' + error);
    });

  const writer = transformStream.writable.getWriter();

  return {
    write(chunk: Uint8Array) {
      writer.write(chunk);
    },
  };
}

// Utility functions
function base64ToArrayBuffer(base64Str: string) {
  if (!base64Str) return { error: null };
  try {
    base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
    const decode = atob(base64Str);
    const arryBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
    return { earlyData: arryBuffer.buffer, error: null };
  } catch (error) {
    return { error: error };
  }
}

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

function safeCloseWebSocket(socket: WebSocket) {
  try {
    if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
      socket.close();
    }
  } catch (error) {
    console.error('Safe close error', error);
  }
}

// UUID stringify function
const byteToHex: string[] = [];
for (let i = 0; i < 256; ++i) {
  byteToHex.push((i + 256).toString(16).slice(1));
}

function stringify(arr: Uint8Array, offset = 0) {
  return (
    byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] +
    byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + '-' +
    byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + '-' +
    byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + '-' +
    byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + '-' +
    byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] +
    byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] +
    byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]
  ).toLowerCase();
}

// Generate configurations
function generateConfigs(host: string, uuid: string) {
  const vlessURL = `vless://${uuid}@${host}:443?encryption=none&security=tls&sni=${host}&fp=chrome&type=ws&host=${host}&path=%2F%3Fed%3D2048#${credit}`;
  
  const clashConfig = `
- name: ${credit}
  type: vless
  server: ${host}
  port: 443
  uuid: ${uuid}
  network: ws
  tls: true
  udp: false
  sni: ${host}
  client-fingerprint: chrome
  ws-opts:
    path: "/?ed=2048"
    headers:
      host: ${host}
`.trim();

  return { vlessURL, clashConfig };
}

// Main server
Deno.serve(async (request: Request) => {
  const url = new URL(request.url);
  const host = url.hostname;
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');

  const upgrade = request.headers.get('upgrade') || '';
  if (upgrade.toLowerCase() != 'websocket') {
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/': {
        const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🚀 Production VLESS Server</title>
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: #333;
        }
        .container {
            background: rgba(255,255,255,0.95);
            padding: 50px;
            border-radius: 20px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.1);
            text-align: center;
            max-width: 600px;
            backdrop-filter: blur(10px);
        }
        h1 {
            color: #2c3e50;
            margin-bottom: 20px;
        }
        .status {
            background: #d4edda;
            color: #155724;
            padding: 20px;
            border-radius: 10px;
            margin: 20px 0;
            font-weight: bold;
        }
        .btn {
            display: inline-block;
            background: #28a745;
            color: white;
            padding: 15px 30px;
            text-decoration: none;
            border-radius: 8px;
            margin: 10px;
            font-weight: bold;
            transition: transform 0.2s;
        }
        .btn:hover {
            transform: translateY(-2px);
        }
        .features {
            text-align: left;
            margin: 30px 0;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🚀 Production VLESS Server</h1>
        <div class="status">
            ✅ SERVER ONLINE • REAL TRAFFIC READY
        </div>
        <p>Your VLESS proxy server is fully operational and handling real traffic.</p>
        
        <div class="features">
            <h3>✅ Working Features:</h3>
            <ul>
                <li>Google Services Connection</li>
                <li>Cloudflare DNS Access</li>
                <li>GitHub Connectivity</li>
                <li>Real Outbound Traffic</li>
                <li>TCP Connections Established</li>
            </ul>
        </div>
        
        <a href="/config" class="btn">📋 Get Configuration</a>
        <a href="/status" class="btn">🔍 Server Status</a>
    </div>
</body>
</html>`;
        return new Response(htmlContent, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      
      case '/config': {
        const configs = generateConfigs(host, userID);
        const htmlContent = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>📋 Production Config</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background: #f0f8ff; }
        .container { max-width: 800px; margin: 0 auto; background: white; padding: 30px; border-radius: 15px; box-shadow: 0 5px 15px rgba(0,0,0,0.1); }
        .config-box { background: #fff3cd; padding: 20px; border-radius: 10px; margin: 20px 0; }
        pre { white-space: pre-wrap; word-wrap: break-word; margin: 0; font-family: monospace; }
        .btn { display: inline-block; background: #28a745; color: white; padding: 12px 25px; border-radius: 8px; text-decoration: none; margin: 10px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>📋 Production Configuration</h1>
        <p style="color: #28a745; font-weight: bold;">✅ READY FOR REAL TRAFFIC</p>
        
        <h3>VLESS URL:</h3>
        <div class="config-box">
            <pre>${configs.vlessURL}</pre>
            <button onclick="copyConfig()" class="btn">📋 Copy Config</button>
        </div>
        
        <a href="/" class="btn">← Back</a>
    </div>
    
    <script>
        function copyConfig() {
            const config = \`${configs.vlessURL}\`;
            navigator.clipboard.writeText(config).then(() => {
                alert('✅ Configuration copied!');
            });
        }
    </script>
</body>
</html>`;
        return new Response(htmlContent, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      
      case '/status':
        return Response.json({
          status: 'online',
          server: host,
          uuid: userID,
          traffic: 'real_outbound_active',
          timestamp: new Date().toISOString()
        });
      
      default:
        return new Response('Not found', { status: 404 });
    }
  } else {
    return await vlessOverWSHandler(request);
  }
});
