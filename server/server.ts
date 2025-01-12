import express from 'express';
import bodyParser from 'body-parser';
import fs from 'fs';
import crypto from 'crypto';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const SECRET_KEY = process.env.SECRET_KEY || 'your-secret-key';

app.use(bodyParser.json());

const BACKENDS_FILE = 'backends.json';

interface Backend {
    id: string;
    name: string;
    ip: string;
    apiKey: string;
    status: boolean;
    tunnels: { id: string, name: string, serverport: number, localport: number, status: boolean }[];
    requestCount: number;
    createdAt: string;
}

let backends: Backend[] = [];

if (fs.existsSync(BACKENDS_FILE)) {
    backends = JSON.parse(fs.readFileSync(BACKENDS_FILE, 'utf-8'));
}

const authenticate = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const token = req.headers['authorization'];
    if (!token) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const decoded = jwt.verify(token, SECRET_KEY);
        (req as any).user = decoded;
        next();
    } catch (err) {
        res.status(401).json({ error: 'Invalid token' });
    }
};

app.post('/login', (req, res) => {
    const { password } = req.body;
    if (password === process.env.PASSWORD) {
        const token = jwt.sign({ userId: 'user-id' }, SECRET_KEY, { expiresIn: '1h' });
        res.json({ success: true, token });
    } else {
        res.status(401).json({ error: 'Invalid password' });
    }
});

app.get('/backends', authenticate, (req, res) => {
    res.json(backends);
});

app.post('/backends', authenticate, (req, res) => {
    const { name} = req.body;
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
    res.json(newBackend);
});

app.put('/backends/:id/toggle', authenticate, (req, res) => {
    const { id } = req.params;
    const backend = backends.find(b => b.id === id);
    if (backend) {
        backend.status = !backend.status;
        fs.writeFileSync(BACKENDS_FILE, JSON.stringify(backends, null, 2));
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

app.post('/backends/:id/tunnels', authenticate, (req, res) => {
    const { id } = req.params;
    const { name, serverport, localport } = req.body;
    const backend = backends.find(b => b.id === id);
    if (backend) {
        const newTunnel = {
            id: crypto.randomBytes(4).toString('hex'),
            name,
            serverport,
            localport,
            status: true,
        };
        backend.tunnels.push(newTunnel);
        fs.writeFileSync(BACKENDS_FILE, JSON.stringify(backends, null, 2));
        res.json(newTunnel);
    } else {
        res.status(404).json({ error: 'Backend not found' });
    }
});

app.put('/backends/:backendId/tunnels/:tunnelId', authenticate, (req, res) => {
    const { backendId, tunnelId } = req.params;
    const { name, localport, serverport } = req.body;
    const backend = backends.find(b => b.id === backendId);
    if (backend) {
        const tunnel = backend.tunnels.find(t => t.id === tunnelId);
        if (tunnel) {
            tunnel.name = name || tunnel.name;
            tunnel.localport = localport || tunnel.localport;
            tunnel.serverport = serverport || tunnel.serverport;
            fs.writeFileSync(BACKENDS_FILE, JSON.stringify(backends, null, 2));
            res.json(tunnel);
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
    backends = backends.filter(b => b.id !== id);
    fs.writeFileSync(BACKENDS_FILE, JSON.stringify(backends, null, 2));
    res.json({ success: true });
});

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/frontend/index.html');
});

app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});