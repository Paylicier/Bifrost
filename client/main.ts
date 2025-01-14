import net from 'net';
import dotenv from 'dotenv';

dotenv.config();

interface TunnelRequest {
    type: string;
    requestId: string;
    tunnelId: string;
    localPort: number;
    targetIp: string;
}

const API_KEY = process.env.API_KEY;
const SERVER_HOST = process.env.SERVER_HOST;
const SERVER_PORT = parseInt(process.env.SERVER_PORT || '9041');

if (!API_KEY) {
    console.error('API_KEY is required');
    process.exit(1);
}

if (!SERVER_HOST) {
    console.error('SERVER_HOST is required');
    process.exit(1);
}

const activeConnections: Map<string, net.Socket> = new Map();

function connectToServer() {
    const socket = new net.Socket();
    let buffer = '';

    socket.connect({
        host: SERVER_HOST,
        port: SERVER_PORT
    }, () => {
        console.log('Connected to server');
        socket.write(JSON.stringify({
            type: 'register',
            apiKey: API_KEY
        }) + '\n');
    });

    socket.on('data', (data) => {
        try {
            buffer += data.toString();
            const messages = buffer.split('\n');
            buffer = messages.pop() || '';

            for (const message of messages) {
                if (!message) continue;
                
                const request = JSON.parse(message);
                
                switch (request.type) {
                    case 'request':
                        handleNewConnection(request, socket);
                        break;
                    case 'data':
                        handleData(request);
                        break;
                    case 'end':
                        handleConnectionEnd(request);
                        break;
                    case 'registered':
                        console.log('Registered as ' + request.name);
                        break;
                    case 'unauthorized':
                        console.error('Failed to register: Unauthorized');
                        process.exit(1);
                        break;
                }
            }
        } catch (error) {
            console.error('Error processing message:', error);
        }
    });

    socket.on('error', (error) => {
        console.error('Connection error:', error);
        setTimeout(connectToServer, 5000);
    });

    socket.on('close', () => {
        console.log('Connection closed, reconnecting...');
        for (const [_, conn] of activeConnections) {
            conn.destroy();
        }
        activeConnections.clear();
        setTimeout(connectToServer, 5000);
    });
}

function handleNewConnection(request: TunnelRequest, serverSocket: net.Socket) {
    console.log(`Creating connection for request ${request.requestId}`);
    
    const connect = (attempt = 1, maxAttempts = 3) => {
        const client = new net.Socket();
        let connected = false;
        let connectTimeout: NodeJS.Timeout;

        const cleanup = () => {
            clearTimeout(connectTimeout);
            if (!connected && attempt < maxAttempts) {
                console.log(`Retrying connection, attempt ${attempt + 1}`);
                connect(attempt + 1);
            } else if (!connected) {
                console.error(`Failed to connect after ${maxAttempts} attempts`);
                serverSocket.write(JSON.stringify({
                    type: 'error',
                    requestId: request.requestId,
                    error: 'Connection failed after max retries'
                }) + '\n');
            }
        };

        connectTimeout = setTimeout(() => {
            if (!connected) {
                client.destroy();
                cleanup();
            }
        }, 5000);

        client.connect({
            host: request.targetIp,
            port: request.localPort
        }, () => {
            console.log(`Connected to ${request.targetIp}:${request.localPort}`);
            connected = true;
            clearTimeout(connectTimeout);
            activeConnections.set(request.requestId, client);

            // Notify server that connection is established
            serverSocket.write(JSON.stringify({
                type: 'connect',
                requestId: request.requestId
            }) + '\n');

            client.on('data', (data) => {
                try {
                    const chunk = {
                        type: 'data',
                        requestId: request.requestId,
                        data: data.toString('base64')
                    };
                    serverSocket.write(JSON.stringify(chunk) + '\n');
                } catch (error) {
                    console.error('Error sending data to server:', error);
                }
            });

            // Set keep-alive to detect connection drops
            client.setKeepAlive(true, 1000);
        });

        client.on('error', (error) => {
            console.error(`Error with target connection: ${error.message}`);
            if (!connected) {
                cleanup();
            } else {
                serverSocket.write(JSON.stringify({
                    type: 'error',
                    requestId: request.requestId,
                    error: error.message
                }) + '\n');
            }
            client.destroy();
            activeConnections.delete(request.requestId);
        });

        client.on('end', () => {
            console.log(`Target connection ended: ${request.requestId}`);
            serverSocket.write(JSON.stringify({
                type: 'end',
                requestId: request.requestId
            }) + '\n');
            activeConnections.delete(request.requestId);
        });

        client.on('close', () => {
            if (connected) {
                console.log(`Connection closed: ${request.requestId}`);
                activeConnections.delete(request.requestId);
            }
        });
    };

    // Start first connection attempt
    connect();
}

function handleData(request: { requestId: string, data: string }) {
    const client = activeConnections.get(request.requestId);
    if (client && client.writable) {
        try {
            const data = Buffer.from(request.data, 'base64');
            client.write(data);
        } catch (error) {
            console.error('Error writing to target:', error);
        }
    }
}

function handleConnectionEnd(request: { requestId: string }) {
    const client = activeConnections.get(request.requestId);
    if (client) {
        client.end();
        activeConnections.delete(request.requestId);
    }
}

// Start the client
console.log('Connecting to '+ SERVER_HOST + ':' + SERVER_PORT);
connectToServer();

process.on('SIGINT', () => {
    console.log('Shutting down...');
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    setTimeout(connectToServer, 5000);
});