import net from 'net';
import crypto from 'crypto';
import winston from 'winston';

interface TunnelConnection {
    socket: net.Socket;
    lastActivity: number;
    retryCount: number;
}

interface TunnelMapping {
    backendId: string;
    tunnelId: string;
    serverPort: number;
    localPort: number;
    targetIp: string;
}

const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const CONNECTION_TIMEOUT = 15000; // 15 seconds
const MAX_RETRIES = 3;

class TunnelServer {
    private backendConnections: Map<string, net.Socket>;
    private tcpServers: Map<string, net.Server>;
    private activeConnections: Map<string, TunnelConnection>;
    private tunnelMappings: Map<number, TunnelMapping>;
    private logger: winston.Logger;

    constructor() {
        this.backendConnections = new Map();
        this.tcpServers = new Map();
        this.activeConnections = new Map();
        this.tunnelMappings = new Map();
        this.logger = this.setupLogger();

        setInterval(() => this.cleanupInactiveConnections(), HEARTBEAT_INTERVAL);
    }

    private setupLogger(): winston.Logger {
        return winston.createLogger({
            level: 'info',
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.json()
            ),
            transports: [
                new winston.transports.Console({
                    format: winston.format.combine(
                        winston.format.colorize(),
                        winston.format.simple()
                    )
                }),
                new winston.transports.File({
                    filename: 'logs/tunnel-error.log',
                    level: 'error'
                }),
                new winston.transports.File({
                    filename: 'logs/tunnel.log'
                })
            ]
        });
    }

    public createTunnelServer(mapping: TunnelMapping): Promise<void> {
        return new Promise((resolve, reject) => {
            const server = net.createServer((clientSocket) => {
                const requestId = crypto.randomBytes(16).toString('hex');
                
                this.logger.info('New client connection', {
                    requestId,
                    serverPort: mapping.serverPort,
                    targetIp: mapping.targetIp,
                    localPort: mapping.localPort
                });

                const backendConnection = this.backendConnections.get(mapping.backendId);
                if (!backendConnection) {
                    this.logger.error('Backend not connected', { requestId });
                    clientSocket.end();
                    return;
                }

                this.activeConnections.set(requestId, {
                    socket: clientSocket,
                    lastActivity: Date.now(),
                    retryCount: 0
                });

                const forwardRequest = () => {
                    const connection = this.activeConnections.get(requestId);
                    if (!connection) return;

                    connection.retryCount++;
                    if (connection.retryCount > MAX_RETRIES) {
                        this.logger.error('Max retries exceeded', { requestId });
                        clientSocket.destroy();
                        this.activeConnections.delete(requestId);
                        return;
                    }

                    const request = {
                        type: 'request',
                        requestId,
                        tunnelId: mapping.tunnelId,
                        localPort: mapping.localPort,
                        targetIp: mapping.targetIp
                    };

                    backendConnection.write(JSON.stringify(request) + '\n');

                    setTimeout(() => {
                        const conn = this.activeConnections.get(requestId);
                        if (conn && !conn.socket.destroyed) {
                            forwardRequest();
                        }
                    }, CONNECTION_TIMEOUT);
                };

                forwardRequest();

                clientSocket.on('data', (data) => {
                    const connection = this.activeConnections.get(requestId);
                    if (connection && backendConnection.writable) {
                        connection.lastActivity = Date.now();
                        const message = {
                            type: 'data',
                            requestId,
                            data: data.toString('base64')
                        };
                        backendConnection.write(JSON.stringify(message) + '\n');
                    }
                });

                clientSocket.on('end', () => {
                    backendConnection.write(JSON.stringify({
                        type: 'end',
                        requestId
                    }) + '\n');
                    this.activeConnections.delete(requestId);
                });

                clientSocket.on('error', (error) => {
                    this.logger.error('Client socket error', {
                        error: error.message,
                        requestId
                    });
                    this.activeConnections.delete(requestId);
                });
            });

            server.listen(mapping.serverPort, '0.0.0.0', () => {
                this.logger.info('Tunnel server started', {
                    port: mapping.serverPort,
                    target: `${mapping.targetIp}:${mapping.localPort}`
                });
                this.tcpServers.set(`${mapping.backendId}-${mapping.tunnelId}`, server);
                this.tunnelMappings.set(mapping.serverPort, mapping);
                resolve();
            });

            server.on('error', (error) => {
                this.logger.error('Tunnel server error', { error: error.message });
                reject(error);
            });
        });
    }

    private cleanupInactiveConnections() {
        const now = Date.now();
        for (const [requestId, connection] of this.activeConnections) {
            if (now - connection.lastActivity > CONNECTION_TIMEOUT) {
                this.logger.info('Cleaning up inactive connection', { requestId });
                connection.socket.destroy();
                this.activeConnections.delete(requestId);
            }
        }
    }

    public handleBackendConnection(socket: net.Socket, backendId: string) {

        console.log('Backend connected');

        let buffer = '';

        this.backendConnections.set(backendId, socket);
        this.logger.info('Backend registered', { backendId });
        socket.write(JSON.stringify({ type: 'registered', backendId }) + '\n');
    
        socket.on('data', (data) => {
            try {
                buffer += data.toString();
                const messages = buffer.split('\n');
                buffer = messages.pop() || '';
    
                for (const message of messages) {
                    if (!message) continue;
                    const response = JSON.parse(message);
        
                    if (response.type === 'connect' || response.type === 'data' || response.type === 'end') {
                        const connection = this.activeConnections.get(response.requestId);
                        if (connection && connection.socket.writable) {
                            connection.lastActivity = Date.now();
                            
                            if (response.type === 'data') {
                                const responseData = Buffer.from(response.data, 'base64');
                                connection.socket.write(responseData);
                            } else if (response.type === 'end') {
                                connection.socket.end();
                                this.activeConnections.delete(response.requestId);
                            }
                        }
                    }
                }
            } catch (error) {
                this.logger.error('Error processing backend message', {
                    error: (error as Error).message,
                    backendId
                });
            }
        });
    
        socket.on('error', (error) => {
            this.logger.error('Backend socket error', {
                error: error.message,
                backendId
            });
            this.handleBackendDisconnection(backendId);
        });
    
        socket.on('close', () => {
            this.handleBackendDisconnection(backendId);
        });
    }

    private handleBackendDisconnection(backendId: string | null) {
        if (backendId) {
            this.logger.info('Backend disconnected', { backendId });
            this.backendConnections.delete(backendId);

            for (const [requestId, connection] of this.activeConnections) {
                const mapping = this.findMappingByRequestId(requestId);
                if (mapping && mapping.backendId === backendId) {
                    connection.socket.destroy();
                    this.activeConnections.delete(requestId);
                }
            }
        }
    }

    private findMappingByRequestId(requestId: string): TunnelMapping | null {
        for (const mapping of this.tunnelMappings.values()) {
            const serverKey = `${mapping.backendId}-${mapping.tunnelId}`;
            if (this.tcpServers.has(serverKey)) {
                return mapping;
            }
        }
        return null;
    }

    public stopTunnel(backendId: string, tunnelId: string) {
        const serverKey = `${backendId}-${tunnelId}`;
        const server = this.tcpServers.get(serverKey);
        
        if (server) {
            this.logger.info('Stopping tunnel server', {
                backendId,
                tunnelId
            });

            server.close(() => {
                this.logger.info('Tunnel server stopped', {
                    backendId,
                    tunnelId
                });
            });

            for (const [requestId, connection] of this.activeConnections) {
                const mapping = this.findMappingByRequestId(requestId);
                if (mapping && mapping.backendId === backendId && mapping.tunnelId === tunnelId) {
                    connection.socket.destroy();
                    this.activeConnections.delete(requestId);
                }
            }

            this.tcpServers.delete(serverKey);
            for (const [port, mapping] of this.tunnelMappings) {
                if (mapping.backendId === backendId && mapping.tunnelId === tunnelId) {
                    this.tunnelMappings.delete(port);
                    break;
                }
            }
        }
    }

    public getStatus() {
        return {
            activeTunnels: Array.from(this.tcpServers.keys()),
            activeBackends: Array.from(this.backendConnections.keys()),
            activeConnections: this.activeConnections.size,
            tunnelMappings: Array.from(this.tunnelMappings.values())
        };
    }

    public isPortAvailable(port: number): boolean {
        return !this.tunnelMappings.has(port);
    }

    public findAvailablePort(min: number = 10000, max: number = 65535): number {
        let port = min;
        while (port <= max) {
            if (this.isPortAvailable(port)) {
                return port;
            }
            port++;
        }
        throw new Error('No available ports found');
    }
}

export class TunnelManager {
    private server: TunnelServer;
    private logger: winston.Logger;
    public handleBackendConnection: (socket: net.Socket) => void;

    constructor() {
        this.server = new TunnelServer();
        this.logger = winston.createLogger({
            level: 'info',
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.json()
            ),
            transports: [
                new winston.transports.Console(),
                new winston.transports.File({ filename: 'logs/tunnel-manager.log' })
            ]
        });
    
        this.handleBackendConnection = this.server.handleBackendConnection.bind(this.server);
    }

    public async createTunnel(config: TunnelMapping): Promise<void> {
        try {
            await this.server.createTunnelServer(config);
            this.logger.info('Tunnel created successfully', config);
        } catch (error) {
            this.logger.error('Failed to create tunnel', {
                error: (error as Error).message,
                config
            });
            throw error;
        }
    }

    public removeTunnel(backendId: string, tunnelId: string): void {
        this.server.stopTunnel(backendId, tunnelId);
        this.logger.info('Tunnel removed', { backendId, tunnelId });
    }

    public getStatus() {
        return this.server.getStatus();
    }

    public isPortAvailable(port: number): boolean {
        return this.server.isPortAvailable(port);
    }

    public findAvailablePort(): number {
        return this.server.findAvailablePort();
    }
}

export default TunnelManager;