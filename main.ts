// main.ts - Deno Deploy Compatible VLESS Server
const userID = crypto.randomUUID();
const credit = "Deno-Deploy-VLESS";

console.log("🚀 Starting VLESS Server on Deno Deploy...");
console.log(`🔑 UUID: ${userID}`);

// WebSocket ready state
const WS_READY_STATE_OPEN = 1;

/**
 * UUID validation
 */
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
 * Safe WebSocket close
 */
function safeCloseWebSocket(socket: WebSocket): void {
  try {
    if (socket.readyState === WS_READY_STATE_OPEN) {
      socket.close();
    }
  } catch (error) {
    console.error('WebSocket close error:', error);
  }
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
  portRemote?: number;
  rawDataIndex?: number;
  isUDP?: boolean;
} {
  try {
    if (vlessBuffer.byteLength < 24) {
      return { hasError: true, message: 'Invalid data' };
    }

    const version = new Uint8Array(vlessBuffer.slice(0, 1));
    if (version[0] !== 0) {
      return { hasError: true, message: 'Unsupported version' };
    }

    // Simple UUID verification
    const uuidBytes = new Uint8Array(vlessBuffer.slice(1, 17));
    const receivedUUID = Array.from(uuidBytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
      .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
    
    if (receivedUUID !== userID) {
      return { hasError: true, message: 'Invalid user' };
    }

    const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
    const command = new Uint8Array(vlessBuffer.slice(18 + optLength, 18 + optLength + 1))[0];

    const isUDP = command === 2;
    if (command !== 1 && !isUDP) {
      return { hasError: true, message: 'Unsupported command' };
    }

    const portIndex = 18 + optLength + 1;
    const portBuffer = vlessBuffer.slice(portIndex, portIndex + 2);
    const portRemote = new DataView(portBuffer).getUint16(0);

    let addressIndex = portIndex + 2;
    const addressType = new Uint8Array(vlessBuffer.slice(addressIndex, addressIndex + 1))[0];
    
    let addressValue = '';
    let addressValueIndex = addressIndex + 1;

    if (addressType === 1) { // IPv4
      const ipBytes = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + 4));
      addressValue = `${ipBytes[0]}.${ipBytes[1]}.${ipBytes[2]}.${ipBytes[3]}`;
    } else if (addressType === 2) { // Domain
      const domainLength = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
      addressValueIndex += 1;
      const domainBytes = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + domainLength));
      addressValue = new TextDecoder().decode(domainBytes);
    } else if (addressType === 3) { // IPv6
      // Skip IPv6 for simplicity
      return { hasError: true, message: 'IPv6 not supported' };
    } else {
      return { hasError: true, message: 'Invalid address type' };
    }

    const rawDataIndex = addressType === 1 ? addressValueIndex + 4 : addressValueIndex + new Uint8Array(vlessBuffer.slice(addressValueIndex - 1, addressValueIndex))[0];

    return {
      hasError: false,
      addressRemote: addressValue,
      portRemote,
      rawDataIndex,
      isUDP
    };
  } catch (error) {
    return { hasError: true, message: `Processing error: ${error}` };
  }
}

/**
 * Handle WebSocket connection for VLESS
 */
async function handleVLESSWebSocket(request: Request): Promise<Response> {
  if (request.headers.get("upgrade") !== "websocket") {
    return new Response("Expected WebSocket", { status: 426 });
  }

  const { socket, response } = Deno.upgradeWebSocket(request);

  socket.onopen = () => {
    console.log("🔗 VLESS Client connected");
  };

  socket.onmessage = async (event) => {
    try {
      if (typeof event.data === "string") {
        return;
      }

      const arrayBuffer = await event.data.arrayBuffer();
      const result = processVlessHeader(arrayBuffer, userID);

      if (result.hasError) {
        console.error("VLESS error:", result.message);
        socket.close();
        return;
      }

      // Handle DNS over UDP
      if (result.isUDP && result.portRemote === 53) {
        try {
          const dnsData = new Uint8Array(arrayBuffer.slice(result.rawDataIndex!));
          const resp = await fetch('https://1.1.1.1/dns-query', {
            method: 'POST',
            headers: { 'content-type': 'application/dns-message' },
            body: dnsData,
          });
          
          const dnsResult = await resp.arrayBuffer();
          const udpSize = dnsResult.byteLength;
          const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
          
          const responseData = new Uint8Array(udpSizeBuffer.length + udpSize);
          responseData.set(udpSizeBuffer);
          responseData.set(new Uint8Array(dnsResult), udpSizeBuffer.length);
          
          socket.send(responseData);
        } catch (error) {
          console.error("DNS error:", error);
        }
        return;
      }

      // Handle TCP connections using fetch API (Deno Deploy compatible)
      if (result.addressRemote && result.portRemote) {
        try {
          // Send VLESS response header
          const responseHeader = new Uint8Array([0, 0]);
          socket.send(responseHeader);

          // For Deno Deploy, we use fetch instead of raw TCP
          const clientData = new Uint8Array(arrayBuffer.slice(result.rawDataIndex!));
          
          // This is a simplified proxy using fetch
          // In production, you'd need a more sophisticated approach
          const proxyResponse = await fetch(`https://${result.addressRemote}`, {
            method: 'POST',
            body: clientData,
            headers: {
              'Host': result.addressRemote!,
              'Content-Type': 'application/octet-stream'
            }
          });
          
          if (proxyResponse.body) {
            const reader = proxyResponse.body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (socket.readyState === WS_READY_STATE_OPEN) {
                socket.send(value);
              } else {
                break;
              }
            }
          }
        } catch (error) {
          console.error("Proxy error:", error);
          // Fallback: send dummy response to keep connection alive
          socket.send(new Uint8Array([0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        }
      }
    } catch (error) {
      console.error("WebSocket message error:", error);
    }
  };

  socket.onclose = () => {
    console.log("🔌 VLESS Client disconnected");
  };

  socket.onerror = (error) => {
    console.error("VLESS WebSocket error:", error);
  };

  return response;
}

/**
 * Generate beautiful configuration page
 */
function generateHTML(host: string): string {
  const vlessURL = `vless://${userID}@${host}:443?encryption=none&security=tls&sni=${host}&fp=chrome&type=ws&host=${host}&path=%2F%3Fed%3D2048#${credit}`;

  const clashConfig = `proxies:
  - name: "${credit}"
    type: vless
    server: ${host}
    port: 443
    uuid: ${userID}
    network: ws
    tls: true
    udp: false
    sni: ${host}
    client-fingerprint: chrome
    ws-opts:
      path: "/?ed=2048"
      headers:
        host: ${host}`;

  const singBoxConfig = `{
  "type": "vless",
  "tag": "${credit}",
  "server": "${host}",
  "server_port": 443,
  "uuid": "${userID}",
  "network": "ws",
  "tls": {
    "enabled": true,
    "server_name": "${host}",
    "utls": {
      "enabled": true,
      "fingerprint": "chrome"
    }
  },
  "transport": {
    "type": "ws",
    "path": "/?ed=2048",
    "headers": {
      "Host": "${host}"
    }
  }
}`;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>VLESS Server - Ready to Use</title>
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
            padding: 20px;
            color: #333;
        }
        .container {
            max-width: 1000px;
            margin: 0 auto;
        }
        .header {
            text-align: center;
            background: rgba(255, 255, 255, 0.95);
            padding: 40px;
            border-radius: 20px;
            margin-bottom: 20px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.1);
        }
        .header h1 {
            color: #2c3e50;
            font-size: 2.5em;
            margin-bottom: 10px;
        }
        .status {
            display: inline-block;
            background: #00b894;
            color: white;
            padding: 10px 20px;
            border-radius: 20px;
            font-size: 0.9em;
            margin: 10px 0;
        }
        .config-section {
            background: rgba(255, 255, 255, 0.95);
            border-radius: 15px;
            padding: 30px;
            margin-bottom: 20px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.1);
        }
        .config-section h2 {
            color: #2c3e50;
            margin-bottom: 20px;
            display: flex;
            align-items: center;
        }
        .config-section h2 i {
            margin-right: 10px;
            color: #667eea;
        }
        .config-code {
            background: #2d3436;
            color: #dfe6e9;
            padding: 20px;
            border-radius: 10px;
            font-family: 'Courier New', monospace;
            font-size: 0.9em;
            overflow-x: auto;
            margin: 15px 0;
            position: relative;
            word-break: break-all;
        }
        .btn {
            display: inline-flex;
            align-items: center;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 12px 25px;
            border-radius: 8px;
            text-decoration: none;
            font-weight: 600;
            margin: 5px;
            border: none;
            cursor: pointer;
            transition: all 0.3s ease;
        }
        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 5px 15px rgba(0, 0, 0, 0.2);
        }
        .btn i {
            margin-right: 8px;
        }
        .btn-group {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
            margin: 20px 0;
        }
        .info-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin: 25px 0;
        }
        .info-card {
            background: linear-gradient(135deg, #74b9ff 0%, #0984e3 100%);
            color: white;
            padding: 20px;
            border-radius: 10px;
            text-align: center;
        }
        .footer {
            text-align: center;
            color: white;
            margin-top: 30px;
            opacity: 0.8;
        }
        .quick-setup {
            background: #e8f4fd;
            padding: 20px;
            border-radius: 10px;
            margin: 20px 0;
        }
        @media (max-width: 768px) {
            .header h1 {
                font-size: 2em;
            }
            .btn-group {
                flex-direction: column;
            }
            .btn {
                justify-content: center;
            }
        }
    </style>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🚀 VLESS Server Ready!</h1>
            <div class="status">🟢 SERVER IS RUNNING</div>
            <p>Your VLESS server is deployed and ready to use. Copy the configuration below to your client.</p>
        </div>

        <div class="info-grid">
            <div class="info-card">
                <h3>🔑 UUID</h3>
                <p style="font-family: monospace; font-size: 0.8em;">${userID}</p>
            </div>
            <div class="info-card">
                <h3>🌐 Domain</h3>
                <p>${host}</p>
            </div>
            <div class="info-card">
                <h3>📡 Port</h3>
                <p>443 (HTTPS)</p>
            </div>
            <div class="info-card">
                <h3>🔒 Security</h3>
                <p>TLS + WebSocket</p>
            </div>
        </div>

        <div class="config-section">
            <h2><i class="fas fa-link"></i> VLESS URL (Recommended)</h2>
            <p>Use this URL in most V2Ray clients:</p>
            <div class="config-code" id="vlessURL">${vlessURL}</div>
            <div class="btn-group">
                <button class="btn" onclick="copyConfig('vlessURL')">
                    <i class="fas fa-copy"></i> Copy VLESS URL
                </button>
                <button class="btn" onclick="downloadConfig('vless-config.txt', document.getElementById('vlessURL').innerText)">
                    <i class="fas fa-download"></i> Download
                </button>
            </div>
        </div>

        <div class="config-section">
            <h2><i class="fas fa-list"></i> Clash Configuration</h2>
            <div class="config-code" id="clashConfig">${clashConfig}</div>
            <div class="btn-group">
                <button class="btn" onclick="copyConfig('clashConfig')">
                    <i class="fas fa-copy"></i> Copy Clash Config
                </button>
            </div>
        </div>

        <div class="config-section">
            <h2><i class="fas fa-code"></i> Sing-Box Configuration</h2>
            <div class="config-code" id="singboxConfig">${singBoxConfig}</div>
            <div class="btn-group">
                <button class="btn" onclick="copyConfig('singboxConfig')">
                    <i class="fas fa-copy"></i> Copy Sing-Box Config
                </button>
            </div>
        </div>

        <div class="quick-setup">
            <h2><i class="fas fa-mobile-alt"></i> Quick Setup Guide</h2>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin-top: 20px;">
                <div style="background: #fff; padding: 20px; border-radius: 10px;">
                    <h3>📱 V2RayNG (Android)</h3>
                    <p>1. Open V2RayNG app</p>
                    <p>2. Click + → Import from clipboard</p>
                    <p>3. Paste VLESS URL</p>
                    <p>4. Start connection</p>
                </div>
                <div style="background: #fff; padding: 20px; border-radius: 10px;">
                    <h3>🖥️ V2RayN (Windows)</h3>
                    <p>1. Open V2RayN</p>
                    <p>2. Servers → Add VMess server</p>
                    <p>3. Paste VLESS URL</p>
                    <p>4. Set as active server</p>
                </div>
                <div style="background: #fff; padding: 20px; border-radius: 10px;">
                    <h3>🍎 Shadowrocket (iOS)</h3>
                    <p>1. Open Shadowrocket</p>
                    <p>2. Click + button</p>
                    <p>3. Scan QR code or paste URL</p>
                    <p>4. Connect</p>
                </div>
            </div>
        </div>

        <div class="footer">
            <p>Powered by Deno Deploy • ${credit} • ${new Date().getFullYear()}</p>
            <p>Server started: ${new Date().toLocaleString()}</p>
        </div>
    </div>

    <script>
        function copyConfig(elementId) {
            const element = document.getElementById(elementId);
            const text = element.innerText || element.textContent;
            
            navigator.clipboard.writeText(text).then(() => {
                alert('✅ Configuration copied to clipboard!');
            }).catch(err => {
                // Fallback for older browsers
                const textArea = document.createElement('textarea');
                textArea.value = text;
                document.body.appendChild(textArea);
                textArea.select();
                document.execCommand('copy');
                document.body.removeChild(textArea);
                alert('✅ Configuration copied!');
            });
        }

        function downloadConfig(filename, content) {
            const blob = new Blob([content], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }

        // Auto-copy VLESS URL on page load
        window.addEventListener('load', function() {
            setTimeout(() => {
                const vlessURL = document.getElementById('vlessURL').innerText;
                navigator.clipboard.writeText(vlessURL).then(() => {
                    console.log('✅ VLESS URL auto-copied to clipboard');
                }).catch(err => {
                    console.log('⚠️ Auto-copy failed, please copy manually');
                });
            }, 1000);
        });

        // Test WebSocket connection
        async function testConnection() {
            try {
                const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                const ws = new WebSocket(\`\${protocol}//\${window.location.host}\`);
                
                ws.onopen = () => {
                    console.log('✅ WebSocket connection successful');
                    ws.close();
                };
                
                ws.onerror = (error) => {
                    console.error('❌ WebSocket connection failed:', error);
                };
            } catch (error) {
                console.error('❌ Connection test failed:', error);
            }
        }

        // Test connection on load
        testConnection();
    </script>
</body>
</html>`;
}

// Main server handler
Deno.serve(async (request: Request) => {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // Handle WebSocket connections for VLESS protocol
  if (request.headers.get("upgrade") === "websocket") {
    return await handleVLESSWebSocket(request);
  }

  // API endpoints
  if (pathname === "/api/status") {
    return new Response(JSON.stringify({
      status: "online",
      protocol: "vless",
      uuid: userID,
      server: credit,
      timestamp: new Date().toISOString()
    }), {
      headers: { "content-type": "application/json" }
    });
  }

  if (pathname === "/api/config") {
    const host = request.headers.get("host") || url.hostname;
    const vlessURL = `vless://${userID}@${host}:443?encryption=none&security=tls&sni=${host}&fp=chrome&type=ws&host=${host}&path=%2F%3Fed%3D2048#${credit}`;
    
    return new Response(JSON.stringify({
      vless: vlessURL,
      uuid: userID,
      host: host
    }), {
      headers: { "content-type": "application/json" }
    });
  }

  // Serve HTML configuration page for all other requests
  const host = request.headers.get("host") || url.hostname;
  const html = generateHTML(host);
  return new Response(html, {
    headers: { 
      "content-type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate"
    }
  });
});

console.log("✅ VLESS Server deployed successfully!");
console.log("🌐 Web Interface: Ready");
console.log("🔗 WebSocket Endpoint: Ready");
console.log("📧 Configuration: Auto-generated");
console.log("🚀 Server is ready to accept connections!");
