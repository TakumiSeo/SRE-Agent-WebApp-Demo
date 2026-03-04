import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { Server } from 'socket.io';
import favicon from 'serve-favicon';
import rateLimit from 'express-rate-limit';

import { start, getContainer, getCosmosClientInfo, runBurst } from './cosmos.js'

import 'dotenv/config'

process.on('unhandledRejection', (reason) => {
  console.error('UnhandledRejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('UncaughtException:', error);
});

const app = express();
const server = createServer(app);
const io = new Server(server, {
  transports: ['websocket', 'polling'],
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
});

const __dirname = dirname(fileURLToPath(import.meta.url));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
});

app.get('/', limiter, (_, res) => {
  const indexPath = join(__dirname, 'static', 'index.html');
  if (existsSync(indexPath)) {
    res.sendFile(indexPath);
    return;
  }
  res.status(200).type('text/plain').send('OK');
});

app.get('/healthz', async (_, res) => {
  try {
    const container = await getContainer();
    const response = await container.read();
    const { endpoint, databaseName, containerName } = getCosmosClientInfo();
    res.status(200).json({
      ok: true,
      endpoint,
      databaseName,
      containerName,
      statusCode: response.statusCode,
      requestCharge: response.requestCharge,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message ?? String(error),
    });
  }
});

app.get('/burst', async (req, res) => {
  const mode = req.query.mode;
  const items = req.query.items;
  const pk = req.query.pk;

  try {
    const result = await runBurst({ mode, items, pk });
    const status = result.throttled429 > 0 ? 429 : 200;
    res.status(status).json({ ok: true, ...result });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message ?? String(error),
    });
  }
});

const faviconPath = join(__dirname, 'static', 'favicon.ico');
if (existsSync(faviconPath)) {
  app.use(favicon(faviconPath));
} else {
  console.warn(`favicon.ico not found at ${faviconPath}; skipping serve-favicon middleware`);
}

app.use(express.static('static'));

io.on('connection', (socket) => {
  console.log(`Connected: ${socket.id}`);

  socket.on('start', async (_) => {
    console.log('Started');
    await start(function emitMessage(message) {
      console.log(message);
      io.emit('new_message', message);
    });
  });
});

io.on('error', (_, error) => {
  console.log(`Error: ${error}`);
});

io.on('disconnect', (_, reason) => {
  console.log(`Disconnected: ${reason}`);
});

const port = process.env.PORT || 3000;
server.listen(port, '0.0.0.0', () => {
  console.log(`Server running on 0.0.0.0:${port}`);
});