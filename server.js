'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const helmet = require('helmet');

const { connect, isConnected } = require('./src/db');
const apiRoutes = require('./src/routes/api');
const adminRoutes = require('./src/routes/admin');
const importador = require('./src/services/importador');
const { apiKeyAuth } = require('./src/middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: false, // dashboard usa CDN de fontes e graficos
    crossOriginEmbedderPolicy: false,
  })
);
app.use(compression());
app.use(
  cors({
    origin: process.env.CORS_ORIGIN && process.env.CORS_ORIGIN !== '*' ? process.env.CORS_ORIGIN.split(',') : true,
    credentials: false,
    exposedHeaders: ['X-Total-Rows', 'Content-Disposition'],
  })
);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Log simples de requisicoes
app.use((req, res, next) => {
  const inicio = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api') || req.path === '/health') {
      console.log(`[http] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - inicio}ms)`);
    }
  });
  next();
});

app.use(apiKeyAuth);

// Status / healthcheck (usado pelo Render)
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    status: 'online',
    database: isConnected() ? 'conectado' : 'desconectado',
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

app.use('/api/admin', adminRoutes);
app.use('/api', apiRoutes);

// Dashboard
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', index: 'index.html' }));

// Fallback (funciona em Express 4 e 5): SPA + 404 de API
app.use((req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ ok: false, error: 'ROTA_NAO_ENCONTRADA' });
  }
  return res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Tratamento de erros
app.use((err, req, res, _next) => {
  console.error('[erro]', err);
  res.status(500).json({ ok: false, error: 'ERRO_INTERNO', message: err.message });
});

async function iniciar() {
  try {
    await connect();
    // Jobs que estavam rodando quando o servidor reiniciou ficam marcados como interrompidos
    await importador.limparJobsOrfaos();
  } catch (erro) {
    console.error('[db] falha ao conectar:', erro.message);
    console.error('[db] o servidor vai subir mesmo assim; o dashboard mostrara o banco como desconectado.');
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log('\n  Buscador de Empresas BR');
    console.log(`  Dashboard: http://localhost:${PORT}`);
    console.log(`  API:       http://localhost:${PORT}/api/companies`);
    console.log(`  Painel:    http://localhost:${PORT}/api/admin/diagnostico`);
    console.log(`  Ambiente:  ${process.env.NODE_ENV || 'development'}`);
    console.log(`  Admin:     ${process.env.ADMIN_TOKEN || process.env.API_KEY ? 'protegido por token' : 'BLOQUEADO (defina ADMIN_TOKEN)'}\n`);
  });
}

iniciar();

module.exports = app;
