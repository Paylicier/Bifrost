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

interface TunnelConnection {
    socket: net.Socket;
    lastActivity: number;
    packetQueue: QueuedPacket[];
    isConnected: boolean;
}

interface QueuedPacket {
    data: string;
    timestamp: number;
}

const API_KEY = process.env.API_KEY;
const SERVER_HOST = process.env.SERVER_HOST;
const SERVER_PORT = parseInt(process.env.SERVER_PORT || '9041');
const HEARTBEAT_INTERVAL = 30000;
const CONNECTION_TIMEOUT = 15000;
const MAX_RETRIES = 3;
const RETRY_DELAY = 5000;
const MAX_QUEUE_SIZE = 1000;
const MAX_PACKET_AGE = 60000;

if (!API_KEY || !SERVER_HOST) {
    console.error('API_KEY and SERVER_HOST are required');
    process.exit(1);
}

const activeConnections = new Map<string, TunnelConnection>();
let serverSocket: net.Socket | null = null;
let reconnecting = false;

function queuePacket(requestId: string, data: string) {
    const connection = activeConnections.get(requestId);
    if (!connection) return;

    connection.packetQueue.push({
        data,
        timestamp: Date.now()
    });

    if (connection.packetQueue.length > MAX_QUEUE_SIZE) {
        connection.packetQueue.shift();
    }
}

function processQueue(requestId: string) {
    const connection = activeConnections.get(requestId);
    if (!connection || !connection.isConnected) return;

    const now = Date.now();
    while (connection.packetQueue.length > 0) {
        const packet = connection.packetQueue[0];
        
        if (now - packet.timestamp > MAX_PACKET_AGE) {
            connection.packetQueue.shift();
            continue;
        }

        if (connection.socket.writable) {
            const data = Buffer.from(packet.data, 'base64');
            connection.socket.write(data as any);
            connection.lastActivity = now;
            connection.packetQueue.shift();
        } else {
            break;
        }
    }
}

function createConnection(request: TunnelRequest, attempt = 1): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const client = new net.Socket();
        let connectTimeout: NodeJS.Timeout;

        const cleanup = () => {
            clearTimeout(connectTimeout);
            client.removeAllListeners();
        };

        connectTimeout = setTimeout(() => {
            cleanup();
            if (attempt < MAX_RETRIES) {
                console.log(`Connection attempt ${attempt} timed out, retrying...`);
                createConnection(request, attempt + 1)
                    .then(resolve)
                    .catch(reject);
            } else {
                reject(new Error('Connection timed out after max retries'));
            }
        }, CONNECTION_TIMEOUT);

        client.connect({
            host: request.targetIp,
            port: request.localPort
        }, () => {
            cleanup();
            console.log(`Connected to ${request.targetIp}:${request.localPort}`);
            resolve(client);
        });

        client.on('error', (error) => {
            cleanup();
            if (attempt < MAX_RETRIES) {
                console.log(`Connection attempt ${attempt} failed, retrying...`);
                setTimeout(() => {
                    createConnection(request, attempt + 1)
                        .then(resolve)
                        .catch(reject);
                }, RETRY_DELAY);
            } else {
                reject(error);
            }
        });
    });
}

function handleNewConnection(request: TunnelRequest) {
    console.log('New connection request:', request);
    if (!serverSocket) {
        console.error('No server connection available');
        return;
    }

    activeConnections.set(request.requestId, {
        socket: null as any,
        lastActivity: Date.now(),
        packetQueue: [],
        isConnected: false
    });

    createConnection(request)
        .then((client) => {
            console.log(`New client connection: ${request.requestId}`);
            
            const connection = activeConnections.get(request.requestId);
            if (!connection) {
                client.end();
                return;
            }
            connection.socket = client;
            connection.isConnected = true;
            console.log(activeConnections.size)

            processQueue(request.requestId);

            serverSocket!.write(JSON.stringify({
                type: 'connect',
                requestId: request.requestId
            }) + '\n');

            client.on('data', (data) => {
                const connection = activeConnections.get(request.requestId);
                if (connection) {
                    connection.lastActivity = Date.now();
                    const chunk = {
                        type: 'data',
                        requestId: request.requestId,
                        data: data.toString('base64')
                    };
                    if (!connection.isConnected) {
                        queuePacket(request.requestId, chunk.data);
                    } else {
                    serverSocket!.write(JSON.stringify(chunk) + '\n');
                    console.log('to client :', chunk.data.length);
                    }
                }
            });

            client.on('end', () => {
                console.log(`Client connection ended: ${request.requestId}`);
                serverSocket!.write(JSON.stringify({
                    type: 'end',
                    requestId: request.requestId
                }) + '\n');
                activeConnections.delete(request.requestId);
            });

            client.on('error', (error) => {
                console.error(`Client connection error: ${error.message}`);
                serverSocket!.write(JSON.stringify({
                    type: 'error',
                    requestId: request.requestId,
                    error: error.message
                }) + '\n');
                activeConnections.delete(request.requestId);
            });

            client.setKeepAlive(true, 1000);
        })
        .catch((error) => {
            console.error(`Failed to establish connection: ${error.message}`);
            serverSocket!.write(JSON.stringify({
                type: 'error',
                requestId: request.requestId,
                error: error.message
            }) + '\n');
        });
}

function handleData(request: { requestId: string; data: string }) {
    const connection = activeConnections.get(request.requestId);
    if(!connection) return;

    if (connection.isConnected && connection.socket.writable) {
        const data = Buffer.from(request.data, 'base64');
        connection.socket.write(data as any);
        connection.lastActivity = Date.now();
    } else {
        queuePacket(request.requestId, request.data);
    }
}

function handleConnectionEnd(request: { requestId: string }) {
    const connection = activeConnections.get(request.requestId);
    if (connection) {
        connection.socket.end();
        activeConnections.delete(request.requestId);
    }
}

function connectToServer() {
    if (reconnecting) return;
    reconnecting = true;

    const socket = new net.Socket();
    let buffer = '';

    socket.connect({
        host: SERVER_HOST,
        port: SERVER_PORT
    }, () => {
        console.log('Connected to server');
        serverSocket = socket;
        reconnecting = false;

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
                        handleNewConnection(request);
                        break;
                    case 'data':
                        handleData(request);
                        break;
                    case 'end':
                        handleConnectionEnd(request);
                        break;
                    case 'registered':
                        console.log('Registered successfully as:', request.backendId);
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
        console.error('Server connection error:', error);
        serverSocket = null;
        setTimeout(connectToServer, RETRY_DELAY);
    });

    socket.on('close', () => {
        console.log('Server connection closed, reconnecting...');
        serverSocket = null;
        for (const [requestId, connection] of activeConnections) {
            connection.socket.destroy();
            activeConnections.delete(requestId);
        }
        setTimeout(connectToServer, RETRY_DELAY);
    });
}

setInterval(() => {
    const now = Date.now();
    for (const [requestId, connection] of activeConnections) {
        connection.packetQueue = connection.packetQueue.filter(
            packet => now - packet.timestamp <= MAX_PACKET_AGE
        );

        if (now - connection.lastActivity > CONNECTION_TIMEOUT) {
            console.log(`Cleaning up inactive connection: ${requestId}`);
            connection.socket.destroy();
            activeConnections.delete(requestId);
        }
    }
}, HEARTBEAT_INTERVAL);

console.log(`Connecting to ${SERVER_HOST}:${SERVER_PORT}`);
connectToServer();

process.on('SIGINT', () => {
    console.log('Shutting down...');
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    if (serverSocket) {
        serverSocket.destroy();
    }
    setTimeout(connectToServer, RETRY_DELAY);
});