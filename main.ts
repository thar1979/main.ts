/**
 * Handles WebSocket connections for VLESS.
 * @param request - The incoming request.
 * @param userID - The UUID for VLESS.
 * @returns WebSocket response.
 */
async function handleWebSocket(request: Request, userID: string) {
  const { socket, response } = Deno.upgradeWebSocket(request);

  socket.onmessage = async (event) => {
    let data: Uint8Array;
    // Check the type of event.data and convert to Uint8Array
    if (event.data instanceof ArrayBuffer) {
      data = new Uint8Array(event.data);
    } else if (event.data instanceof Blob) {
      data = new Uint8Array(await event.data.arrayBuffer());
    } else if (typeof event.data === "string") {
      data = new TextEncoder().encode(event.data);
    } else {
      socket.close(1000, "Unsupported data type received");
      return;
    }

    const { hasError, message, addressRemote, portRemote, rawDataIndex } =
      processVlessHeader(data.buffer, userID);

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
          close() {
            console.log("TCP stream closed");
          },
          abort(reason) {
            console.error("TCP stream aborted:", reason);
            socket.close(1000, "Connection aborted");
          },
        }),
      ).catch((e) => {
        console.error("Pipe error:", e);
        socket.close(1000, "Pipe error");
      });
    } catch (e) {
      console.error("TCP connection error:", e.message);
      socket.close(1000, "Connection error");
    }
  };

  socket.onclose = () => console.log("WebSocket closed");
  socket.onerror = (e) => console.error("WebSocket error:", e);

  return response;
}
