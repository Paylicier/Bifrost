import express from 'express';
import bodyParser from 'body-parser';
import fs from 'fs';
import crypto from 'crypto';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import winston from 'winston';

import TunnelManager from './tunnel-server';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({
            filename: 'logs/error.log',
            level: 'error',
            maxsize: 5242880,
            maxFiles: 5
        }),
        new winston.transports.File({
            filename: 'logs/combined.log',
            maxsize: 5242880,
            maxFiles: 5
        }),
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        })
    ]
});

if (!fs.existsSync('logs')) {
    fs.mkdirSync('logs');
}

const app = express();
const port = process.env.PORT || 9040;
const backendPort = parseInt(process.env.BACKEND_PORT as string) || 9041;
const SECRET_KEY = process.env.SECRET_KEY || 'thisisareallylongsecretkeythatshouldnotbeusedinproduction';

if (!process.env.PASSWORD) {
    logger.error('No password provided, please provide one using PASSWORD=yourpassword in your .env or environment variables');
    process.exit(1);
}

let passwordattempts: Map<string, number> = new Map();

app.use(bodyParser.json());

const BACKENDS_FILE = 'backends.json';

interface Backend {
    id: string;
    name: string;
    ip: string;
    apiKey: string;
    status: boolean;
    tunnels: {
        id: string;
        name: string;
        serverport: number;
        localport: number;
        status: boolean;
        targetIp: string;
    }[];
    requestCount: number;
    createdAt: string;
    lastSeen: string;
    uptime: number;
}


const backendConnections: Map<string, net.Socket> = new Map();
const tunnelManager = new TunnelManager();

let backends: Backend[] = [];

if (fs.existsSync(BACKENDS_FILE)) {
    backends = JSON.parse(fs.readFileSync(BACKENDS_FILE, 'utf-8'));
} else {
    fs.writeFileSync(BACKENDS_FILE, '[]');
}

function saveBackends() {
    try {
        fs.writeFileSync(BACKENDS_FILE, JSON.stringify(backends, null, 2));
    } catch (error) {
        logger.error('Error saving backends file:', { error });
    }
}


setInterval(() => {
    const now = Date.now();
    backends.forEach(backend => {
        const connection = backendConnections.get(backend.id);
        if (connection) {
            backend.status = true;
            backend.uptime += 30; // 30 seconds
            backend.ip = connection.remoteAddress || '';
            backend.lastSeen = new Date().toISOString();
        } else {
            backend.status = false;
            backend.uptime = 0; // Not connected
        }
    });
    saveBackends();
}, 30000); // Every 30 seconds


const backendServer = net.createServer((socket) => {
    let backendId: string | null = null;
    
    socket.on('data', (data) => {
        try {
            const messages = data.toString().split('\n');
            for (const msg of messages) {
                if (!msg) continue;
                
                const message = JSON.parse(msg);
                if (message.type === 'register') {
                    const backend = backends.find(b => b.apiKey === message.apiKey);
                    if (backend) {
                        backendId = backend.id;
                        backend.ip = socket.remoteAddress || '';
                        backend.lastSeen = new Date().toISOString();
                        backend.status = true;
                        backend.uptime = 1;
                        backendConnections.set(backend.id, socket);
                                                
                        tunnelManager.handleBackendConnection(socket, backend.id);
                        
                        logger.info('Backend connected', { backendId, ip: backend.ip });
                        saveBackends();
                    } else {
                        logger.warn('Invalid backend registration attempt', { apiKey: message.apiKey });
                        socket.write(JSON.stringify({ type: 'unauthorized' }) + '\n');
                        socket.end();
                    }
                }
            }
        } catch (error) {
            logger.error('Error processing backend message', { error: (error as Error).message });
        }
    });

    socket.on('error', (error) => {
        logger.error('Backend socket error', { error: error.message, backendId });
    });

    socket.on('close', () => {
        if (backendId) {
            backendConnections.delete(backendId);
            const backend = backends.find(b => b.id === backendId);
            if (backend) {
                backend.status = false;
                backend.uptime = 0;
                saveBackends();
            }
            logger.info('Backend disconnected', { backendId });
        }
    });
});

backendServer.listen(backendPort, () => {
    logger.info(`Backend server listening on port ${backendPort}`);
});

app.listen(port, () => {
    logger.info(`HTTP server listening on port ${port}`);
});

async function createTunnelServer(backend: Backend, tunnel: Backend['tunnels'][0]): Promise<void> {
    const serverKey = `${backend.id}-${tunnel.id}`;

    try {
        await tunnelManager.createTunnel({
            backendId: backend.id,
            tunnelId: tunnel.id,
            serverPort: tunnel.serverport,
            localPort: tunnel.localport,
            targetIp: tunnel.targetIp
        });
        logger.info('Tunnel server created', {
            backendId: backend.id,
            tunnelId: tunnel.id,
            serverPort: tunnel.serverport
        });
    } catch (error) {
        logger.error('Failed to create tunnel server', {
            error: (error as Error).message,
            backendId: backend.id,
            tunnelId: tunnel.id
        });
        throw error;
    }
}

function stopTunnelServer(backendId: string, tunnelId: string) {
    tunnelManager.removeTunnel(backendId, tunnelId);
}


function updateTunnelServers(backends: Backend[]) {
    backends.forEach(backend => {
        if (backend.status) {
            backend.tunnels.forEach(tunnel => {
                if (tunnel.status) {
                    createTunnelServer(backend, tunnel).catch(error => {
                        logger.error('Failed to update tunnel server', {
                            error: error.message,
                            backendId: backend.id,
                            tunnelId: tunnel.id
                        });
                    });
                } else {
                    stopTunnelServer(backend.id, tunnel.id);
                }
            });
        }
    });
}

const authenticate = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const token = req.headers['authorization'];
    if (!token) {
        logger.warn('Authentication failed: No token provided', {
            path: req.path,
            method: req.method
        });
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const decoded = jwt.verify(token, SECRET_KEY);
        (req as any).user = decoded;
        logger.info('Authentication successful', {
            path: req.path,
            method: req.method,
            userId: (decoded as any).userId
        });
        next();
    } catch (err) {
        logger.error('Authentication failed: Invalid token', {
            method: req.method,
            error: err.message
        });
        res.status(401).json({ error: 'Invalid token' });
    }
};

app.use((req, res, next) => {
    logger.info('Incoming request', {
        path: req.path,
        method: req.method,
        ip: req.ip
    });
    next();
});

app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
    logger.error('Unhandled error', {
        error: err.message,
        stack: err.stack,
        path: req.path,
        method: req.method
    });
    res.status(500).json({ error: 'Internal server error' });
});


app.post('/login', (req, res) => {
    const { password } = req.body;
    // ✨ Bruteforce protection ✨ (it's not perfect but it's something)
    if (passwordattempts.has(req.ip) && passwordattempts.get(req.ip) >= 3) {
        logger.warn('Too many login attempts', { ip: req.ip });
        return res.status(429).json({ error: 'Too many attempts' });
    }
    if (password === process.env.PASSWORD) {
        passwordattempts.delete(req.ip);
        const token = jwt.sign({ userId: 'admin' }, SECRET_KEY, { expiresIn: '1h' });
        res.json({ success: true, token });
    } else {
        if (passwordattempts.has(req.ip)) {
            passwordattempts.set(req.ip, passwordattempts.get(req.ip) + 1);
            // Remove attempt after 5 minutes because it's better to not lock out the user :beluclown:
            setTimeout(() => {
                passwordattempts.set(req.ip, passwordattempts.get(req.ip) - 1);
            }, 300000);
        } else {
            passwordattempts.set(req.ip, 1);
        }
        logger.warn('Invalid password', { ip: req.ip });
        res.status(401).json({ error: 'Invalid password' });
    }
});

app.get('/backends', authenticate, (req, res) => {
    res.json(backends);
});

app.post('/backends', authenticate, (req, res) => {
    const { name } = req.body;
    const newBackend: Backend = {
        id: crypto.randomBytes(8).toString('hex'),
        name,
        ip: "",
        apiKey: crypto.randomBytes(16).toString('hex'),
        status: true,
        tunnels: [],
        requestCount: 0,
        createdAt: new Date().toISOString(),
    };
    backends.push(newBackend);
    fs.writeFileSync(BACKENDS_FILE, JSON.stringify(backends, null, 2));
    updateTunnelServers(backends);
    res.json(newBackend);
});

app.put('/backends/:id/toggle', authenticate, (req, res) => {
    const { id } = req.params;
    const backend = backends.find(b => b.id === id);
    if (backend) {
        backend.status = !backend.status;
        fs.writeFileSync(BACKENDS_FILE, JSON.stringify(backends, null, 2));
        updateTunnelServers(backends);
        res.json(backend);
    } else {
        res.status(404).json({ error: 'Backend not found' });
    }
});

app.put('/backends/:id', authenticate, (req, res) => {
    const { id } = req.params;
    const { name } = req.body;
    const backend = backends.find(b => b.id === id);
    if (backend) {
        backend.name = name || backend.name;
        fs.writeFileSync(BACKENDS_FILE, JSON.stringify(backends, null, 2));
        res.json(backend);
    } else {
        res.status(404).json({ error: 'Backend not found' });
    }
});

app.post('/backends/:backendId/regenerate-key', authenticate, (req, res) => {
    const { backendId } = req.params;
    const backend = backends.find(b => b.id === backendId);
    if (backend) {
        backend.apiKey = crypto.randomBytes(16).toString('hex');
        fs.writeFileSync(BACKENDS_FILE, JSON.stringify(backends, null, 2));
        res.json(backend);
    } else {
        res.status(404).json({ error: 'Backend not found' });
    }
});

app.get('/backends/:id/tunnels', authenticate, (req, res) => {
    const { id } = req.params;
    const backend = backends.find(b => b.id === id);
    if (backend) {
        res.json(backend.tunnels);
    } else {
        res.status(404).json({ error: 'Backend not found' });
    }
});

app.get('/backends/:id/', authenticate, (req, res) => {
    const { id } = req.params;
    const backend = backends.find(b => b.id === id);
    if (backend) {
        res.json(backend);
    } else {
        res.status(404).json({ error: 'Backend not found' });
    }
});

app.get('/check-port/:port', authenticate, (req, res) => {
    const port = parseInt(req.params.port);

    if (port < 1024 || port > 65535) {
        return res.status(400).json({
            available: false,
            error: 'Port must be between 1024 and 65535'
        });
    }

    res.json({ available: tunnelManager.isPortAvailable(port) });
});

app.get('/random-port', authenticate, (req, res) => {
    try {
        const port = tunnelManager.findAvailablePort();
        res.json({ port });
    } catch (error) {
        res.status(500).json({ error: 'Could not find an available port' });
    }
});

app.post('/backends/:id/tunnels', authenticate, async (req, res) => {
    const { id } = req.params;
    const { name, serverport, localport, targetIp } = req.body;
    const backend = backends.find(b => b.id === id);

    if (!backend) {
        return res.status(404).json({ error: 'Backend not found' });
    }


    const portInUse = backends.some(b =>
        b.tunnels.some(t =>
            t.serverport === parseInt(serverport) && t.status
        )
    );

    if (portInUse) {
        return res.status(400).json({
            error: `Port ${serverport} is already in use by another tunnel`
        });
    }

    const newTunnel = {
        id: crypto.randomBytes(4).toString('hex'),
        name,
        serverport: parseInt(serverport),
        localport: parseInt(localport),
        targetIp: targetIp || 'localhost',
        status: true,
    };

    try {
        await createTunnelServer(backend, newTunnel);
        backend.tunnels.push(newTunnel);
        fs.writeFileSync(BACKENDS_FILE, JSON.stringify(backends, null, 2));
        res.json(newTunnel);
    } catch (error) {
        logger.error('Failed to create tunnel', {
            error: error.message,
            backendId: id,
            serverport
        });
        res.status(400).json({
            error: `Failed to create tunnel: ${error.message}`
        });
    }
});
app.put('/backends/:backendId/tunnels/:tunnelId', authenticate, (req, res) => {
    const { backendId, tunnelId } = req.params;
    const { name, localport, serverport, targetIp } = req.body;
    const backend = backends.find(b => b.id === backendId);
    if (backend) {
        const tunnel = backend.tunnels.find(t => t.id === tunnelId);
        if (tunnel) {
            tunnel.name = name || tunnel.name;
            tunnel.localport = localport || tunnel.localport;
            tunnel.serverport = serverport || tunnel.serverport;
            tunnel.targetIp = targetIp || tunnel.targetIp;
            fs.writeFileSync(BACKENDS_FILE, JSON.stringify(backends, null, 2));
            updateTunnelServers(backends);
            res.json(backend.tunnels.find(t => t.id === tunnelId));
        } else {
            res.status(404).json({ error: 'Tunnel not found' });
        }
    } else {
        res.status(404).json({ error: 'Backend not found' });
    }
});

app.delete('/backends/:backendId/tunnels/:tunnelId', authenticate, (req, res) => {
    const { backendId, tunnelId } = req.params;
    const backend = backends.find(b => b.id === backendId);
    if (backend) {
        backend.tunnels = backend.tunnels.filter(t => t.id !== tunnelId);
        fs.writeFileSync(BACKENDS_FILE, JSON.stringify(backends, null, 2));
        stopTunnelServer(backendId, tunnelId);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Backend not found' });
    }
});

app.put('/backends/:backendId/tunnels/:tunnelId/toggle', authenticate, (req, res) => {
    const { backendId, tunnelId } = req.params;
    const backend = backends.find(b => b.id === backendId);
    if (backend) {
        const tunnel = backend.tunnels.find(t => t.id === tunnelId);
        if (tunnel) {
            tunnel.status = !tunnel.status;
            fs.writeFileSync(BACKENDS_FILE, JSON.stringify(backends, null, 2));
            updateTunnelServers(backends);
            res.json(tunnel);
        } else {
            res.status(404).json({ error: 'Tunnel not found' });
        }
    } else {
        res.status(404).json({ error: 'Backend not found' });
    }
});

app.delete('/backends/:id', authenticate, (req, res) => {
    const { id } = req.params;
    const backend = backends.find(b => b.id === id);
    if (backend) {

        backend.tunnels.forEach(tunnel => {
            stopTunnelServer(backend.id, tunnel.id);
        });
        backends = backends.filter(b => b.id !== id);
        fs.writeFileSync(BACKENDS_FILE, JSON.stringify(backends, null, 2));
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Backend not found' });
    }
});

app.get('/debug/tunnels', authenticate, (req, res) => {
    res.json(tunnelManager.getStatus());
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'frontend/index.html'));
});

app.use(express.static(path.join(__dirname, 'frontend')));

if (fs.existsSync(BACKENDS_FILE)) {
    updateTunnelServers(backends);
}

process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', {
        error: error.message,
        stack: error.stack
    });
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled rejection', {
        reason,
        promise
    });
});