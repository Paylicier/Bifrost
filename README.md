<div align="center">
<br>
  <img src="https://raw.githubusercontent.com/Paylicier/Bifrost/refs/heads/main/server/frontend/logo.svg" alt="Bifrost Logo" width="400"/>

# Bifrost 🌈

A simple and easy to use TCP Tunnel with a webUI to expose your local services.
</div>

## Features ✨

- 🌐 WebUI
  - Authentification
  - Add backends and tunnels easily
  - Regenerate API Keys
 
- ⌛ Easy to setup
  - No need to open port on client
  - One-click setup
  - Compatible with docker

## Architecture Overview 🏗️

The system consists of two main components:

1. **Server**: Handles WebUI and tunnel output
2. **Client**: Connects to server and forwards local traffic

## Setup 🚀

### Prerequisites

- Bun 1.1.34+
- 1 server with a public ipv4
- 1 client

### Server Setup

#### Standalone

1. Clone the repo:
```bash
git clone https://github.com/Paylicier/Bifrost
```

2. Install dependencies:
```bash
bun install
```

3. Configure environment variables in `.env`:
```env
PORT=9040
BACKEND_PORT=9041
PASSWORD=your_secure_password
SECRET_KEY=your_jwt_secret_key
```

4. Start the server:
```bash
cd server
bun main.ts
```

#### Docker

1. Create a backend.json file
```bash
echo "[]" > backends.json
```

2. Start the container
```bash
docker run -d --name bifrost-server \
  --network host \
  -e PORT=9040 \
  -e BACKEND_PORT=9041 \
  -e PASSWORD=your_secure_password \
  -e SECRET_KEY=your_jwt_secret_key \
  -v $(pwd)/backends.json:/app/backends.json \
  paylicier/bifrost-server
```

### Backend Client Setup

#### Standalone

1. Clone the repo:
```bash
git clone https://github.com/Paylicier/Bifrost
```

2. Configure environment variables in `.env`:
```env
API_KEY=your_api_key
SERVER_HOST=your_server_host
SERVER_PORT=9041
```

3. Start the backend client:
```bash
cd client
bun main.ts
```

#### Docker

1. Start the container
```bash
docker run -d --name bifrost-client \
  -e API_KEY=your_api_key \
  -e SERVER_HOST=your_server_host \
  -e SERVER_PORT=9041 \
  paylicier/bifrost-client
```

## API Documentation 📚

### Authentication Endpoints

- `POST /login`
  - Login with admin password
  - Returns JWT token

### Backend Management

- `GET /backends`
  - List all registered backends
- `POST /backends`
  - Register new backend
- `DELETE /backends/:id`
  - Remove backend
- `POST /backends/:id/regenerate-key`
  - Regenerate backend API key

### Tunnel Management

- `GET /backends/:id/tunnels`
  - List tunnels for backend
- `POST /backends/:id/tunnels`
  - Create new tunnel
- `DELETE /backends/:id/tunnels/:tunnelId`
  - Remove tunnel
- `PUT /backends/:id/tunnels/:tunnelId/toggle`
  - Toggle tunnel status

### Port Management

- `GET /check-port/:port`
  - Check port availability
- `GET /random-port`
  - Get available random port

## Contributing 🤝

1. Fork the repository
2. Create feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit changes (`git commit -m 'Add AmazingFeature'`)
4. Push to branch (`git push origin feature/AmazingFeature`)
5. Open Pull Request

---

<div align="center">
Built with 🥟 and ❤️ for 🌊
</div>
