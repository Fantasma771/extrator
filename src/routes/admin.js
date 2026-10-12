'use strict';

/**
 * Painel de administracao: importacao dos dados da Receita Federal
 * executada DENTRO do Render (sem precisar da maquina do usuario).
 *
 * Protegido por ADMIN_TOKEN (ou API_KEY, se ADMIN_TOKEN nao existir).
 */

const express = require('express');
const Company = require('../models/Company');
const Municipio = require('../models/Municipio');
const ImportJob = require('../models/ImportJob');
const importador = require('../services/importador');
const { isConnected } = require('../db');
const { baseUrl } = require('../lib/fontes');
const { UFS } = require('../lib/tables');

const router = express.Router();

/* ------------------------------------------------------------------ */
/* Autenticacao do painel                                              */
/* ------------------------------------------------------------------ */
function tokenAdmin() {
  return process.env.ADMIN_TOKEN || process.env.API_KEY || '';
}

function adminAuth(req, res, next) {
  const esperado = tokenAdmin();
  if (!esperado) {
    return res.status(403).json({
      ok: false,
      error: 'ADMIN_TOKEN_NAO_CONFIGURADO',
      message:
        'Por seguranca, defina a variavel de ambiente ADMIN_TOKEN no Render para liberar a importacao pelo painel. ' +
        'Sem ela, qualquer visitante poderia disparar uma importacao.',
    });
  }
  const enviado =
    req.get('x-admin-token') ||
    req.get('x-api-key') ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '') ||
    req.query.token;

  if (enviado && String(enviado) === String(esperado)) return next();

  return res.status(401).json({ ok: false, error: 'NAO_AUTORIZADO', message: 'Token de administracao invalido.' });
}

router.use((req, res, next) => {
  if (!isConnected()) {
    return res.status(503).json({ ok: false, error: 'BANCO_DESCONECTADO', message: 'Sem conexao com o MongoDB.' });
  }
  return next();
});

/* ------------------------------------------------------------------ */
/* Diagnostico                                                         */
/* ------------------------------------------------------------------ */
router.get('/diagnostico', adminAuth, async (req, res, next) => {
  try {
    const [total, municipios, porUf, jobs] = await Promise.all([
      Company.estimatedDocumentCount(),
      Municipio.estimatedDocumentCount(),
      Company.aggregate([{ $group: { _id: '$endereco.uf', total: { $sum: 1 } } }, { $sort: { total: -1 } }]),
      ImportJob.find({}, { log: 0 }).sort({ iniciadoEm: -1 }).limit(5).lean(),
    ]);

    res.json({
      ok: true,
      data: {
        base: { total, municipios, porUf: porUf.map((u) => ({ uf: u._id || '??', total: u.total })) },
        servidor: {
          uptime: Math.round(process.uptime()),
          node: process.version,
          memoriaMB: Math.round(process.memoryUsage().rss / 1048576),
          fonteDados: baseUrl(),
          adminProtegido: !!tokenAdmin(),
          ufs: UFS,
        },
        ultimosJobs: jobs,
      },
    });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ */
/* Iniciar importacao                                                  */
/* ------------------------------------------------------------------ */
router.post('/import', adminAuth, async (req, res, next) => {
  try {
    const b = req.body || {};
    if (importador.jobAtivo()) {
      return res.status(409).json({
        ok: false,
        error: 'IMPORTACAO_EM_ANDAMENTO',
        message: 'Ja existe uma importacao rodando. Aguarde ou cancele a atual.',
      });
    }

    const uf = String(b.uf || '').toUpperCase().trim();
    if (uf && !UFS.includes(uf)) {
      return res.status(400).json({ ok: false, error: 'UF_INVALIDA', message: `UF invalida: ${uf}` });
    }

    const job = await importador.iniciarJob({
      uf,
      drop: !!b.drop,
      skipSocios: !!b.skipSocios,
      skipSimples: !!b.skipSimples,
      limit: Number(b.limit) || 0,
      remoto: b.remoto !== false,
      dataDir: b.dataDir || undefined,
    });

    return res.json({
      ok: true,
      data: { id: String(job._id), status: 'executando', uf: uf || 'TODAS' },
      message: `Importacao iniciada para ${uf || 'TODO O BRASIL'}. Acompanhe o progresso ao vivo.`,
    });
  } catch (e) {
    if (e.message === 'JA_EXISTE_IMPORTACAO_EM_ANDAMENTO') {
      return res.status(409).json({ ok: false, error: e.message, message: 'Ja existe uma importacao em andamento.' });
    }
    return next(e);
  }
});

/* ------------------------------------------------------------------ */
/* Listar / consultar jobs                                             */
/* ------------------------------------------------------------------ */
router.get('/imports', adminAuth, async (req, res, next) => {
  try {
    const jobs = await importador.listarJobs(20);
    return res.json({ ok: true, data: jobs, ativo: importador.jobAtivo() });
  } catch (e) {
    return next(e);
  }
});

router.get('/import/:id', adminAuth, async (req, res, next) => {
  try {
    const job = await importador.obterJob(req.params.id);
    if (!job) return res.status(404).json({ ok: false, error: 'JOB_NAO_ENCONTRADO' });
    return res.json({ ok: true, data: job, ativo: importador.jobAtivo() === String(job._id) });
  } catch (e) {
    return next(e);
  }
});

router.post('/import/:id/cancelar', adminAuth, async (req, res, next) => {
  try {
    const ok = await importador.cancelarJob(req.params.id);
    if (!ok) return res.status(404).json({ ok: false, error: 'JOB_NAO_ESTA_RODANDO' });
    return res.json({ ok: true, message: 'Cancelamento solicitado.' });
  } catch (e) {
    return next(e);
  }
});

/* ------------------------------------------------------------------ */
/* Progresso ao vivo (SSE)                                             */
/* ------------------------------------------------------------------ */
router.get('/import/:id/eventos', adminAuth, async (req, res) => {
  const id = String(req.params.id);

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const enviar = async () => {
    try {
      const job = await importador.obterJob(id);
      if (!job) {
        res.write(`event: erro\ndata: ${JSON.stringify({ message: 'Job nao encontrado' })}\n\n`);
        return false;
      }
      res.write(`data: ${JSON.stringify({ job, ativo: importador.jobAtivo() === id })}\n\n`);
      return job.status === 'executando';
    } catch (e) {
      res.write(`event: erro\ndata: ${JSON.stringify({ message: e.message })}\n\n`);
      return false;
    }
  };

  const intervalo = setInterval(async () => {
    const continuar = await enviar();
    if (!continuar) {
      clearInterval(intervalo);
      clearInterval(batimento);
      res.write('event: fim\ndata: {}\n\n');
      res.end();
    }
  }, 2000);

  const batimento = setInterval(() => { res.write(': ping\n\n'); }, 15000);

  req.on('close', () => { clearInterval(intervalo); clearInterval(batimento); });
  await enviar();
});

module.exports = router;
