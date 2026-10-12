'use strict';

const express = require('express');
const zlib = require('zlib');
const { once } = require('events');

const Company = require('../models/Company');
const Municipio = require('../models/Municipio');
const { construirFiltro, construirOrdenacao, PROJECAO_LISTA, inteiro } = require('../lib/query');
const { SITUACOES, TIPOS, UFS, PORTES } = require('../lib/tables');
const { formatarCnpj } = require('../lib/normalize');
const exporters = require('../lib/exporters');
const { isConnected } = require('../db');

const router = express.Router();

/** Garante que o banco esta conectado antes de responder */
router.use((req, res, next) => {
  if (!isConnected()) {
    return res.status(503).json({
      ok: false,
      error: 'BANCO_DESCONECTADO',
      message: 'Sem conexao com o MongoDB. Verifique a variavel MONGODB_URI.',
    });
  }
  return next();
});

/* ------------------------------------------------------------------ */
/* GET /api/meta  -> opcoes de filtros para o dashboard               */
/* ------------------------------------------------------------------ */
router.get('/meta', async (req, res, next) => {
  try {
    const [ufsComDados, municipiosMapeados] = await Promise.all([
      Company.distinct('endereco.uf'),
      Municipio.estimatedDocumentCount(),
    ]);
    res.json({
      ok: true,
      data: {
        ufs: UFS,
        ufsComDados: ufsComDados.filter(Boolean).sort(),
        tipos: TIPOS,
        situacoes: Object.values(SITUACOES),
        portes: [...new Set(Object.values(PORTES))],
        municipiosMapeados,
        total: await Company.estimatedDocumentCount(),
      },
    });
  } catch (erro) {
    next(erro);
  }
});

/* ------------------------------------------------------------------ */
/* GET /api/municipios?uf=SP&q=saopaulo&limit=30                      */
/* ------------------------------------------------------------------ */
router.get('/municipios', async (req, res, next) => {
  try {
    const uf = String(req.query.uf || '').toUpperCase().trim();
    const q = String(req.query.q || '').trim();
    const limit = Math.min(inteiro(req.query.limit, 40), 500);
    const { normalizar, escapeRegex } = require('../lib/normalize');

    const filtro = {};
    if (uf && uf !== 'TODOS') filtro.uf = uf;
    if (q) filtro.nomeNormalizado = new RegExp(escapeRegex(normalizar(q)), 'i');

    // Conta quantas empresas existem em cada municipio (para mostrar na lista)
    const agrupar = async (condicao) => {
      const agg = await Company.aggregate([
        { $match: condicao },
        { $group: { _id: { m: '$endereco.municipio', c: '$endereco.codigoMunicipio', uf: '$endereco.uf' }, total: { $sum: 1 } } },
        { $sort: { total: -1 } },
        { $limit: limit },
      ]);
      return agg.filter((x) => x._id.m);
    };

    let lista = await Municipio.find(filtro).sort({ nome: 1 }).limit(limit).lean();

    // Anexa a contagem real de empresas por municipio
    const condicaoBase = uf && uf !== 'TODOS' ? { 'endereco.uf': uf } : {};
    const comDados = await agrupar(condicaoBase);
    const mapa = new Map(comDados.map((x) => [String(x._id.c || x._id.m), x.total]));

    lista = lista.map((m) => ({
      nome: m.nome,
      uf: m.uf,
      codigo: m.codigo,
      total: mapa.get(String(m.codigo)) || 0,
    }));

    // Ordena por quantidade de empresas (mais util para o usuario)
    lista.sort((a, b) => b.total - a.total || a.nome.localeCompare(b.nome, 'pt-BR'));

    if (!lista.length) {
      lista = comDados.slice(0, limit).map((x) => ({ nome: x._id.m, uf: x._id.uf, codigo: x._id.c || null, total: x.total }));
    }

    res.json({ ok: true, total: lista.length, data: lista });
  } catch (erro) {
    next(erro);
  }
});

/* ------------------------------------------------------------------ */
/* GET /api/count -> contagem EXATA do filtro (confirma a varredura)   */
/* ------------------------------------------------------------------ */
router.get('/count', async (req, res, next) => {
  try {
    const filtro = construirFiltro(req.query);

    const [total, porSituacao, municipios, socios] = await Promise.all([
      Company.countDocuments(filtro),
      Company.aggregate([{ $match: filtro }, { $group: { _id: '$situacao', total: { $sum: 1 } } }, { $sort: { total: -1 } }]),
      Company.aggregate([
        { $match: filtro },
        { $group: { _id: { m: '$endereco.municipio', c: '$endereco.codigoMunicipio', uf: '$endereco.uf' }, total: { $sum: 1 } } },
        { $sort: { total: -1 } },
        { $limit: 200 },
      ]),
      Company.aggregate([
        { $match: filtro },
        { $group: { _id: null, totalSocios: { $sum: '$sociosCount' }, comSocios: { $sum: { $cond: [{ $gt: ['$sociosCount', 0] }, 1, 0] } } } },
      ]),
    ]);

    res.json({
      ok: true,
      data: {
        total,
        totalSocios: socios[0]?.totalSocios || 0,
        empresasComSocios: socios[0]?.comSocios || 0,
        porSituacao: porSituacao.map((s) => ({ nome: s._id || 'NAO INFORMADA', total: s.total })),
        municipios: municipios
          .filter((m) => m._id.m)
          .map((m) => ({ nome: m._id.m, codigo: m._id.c, uf: m._id.uf, total: m.total })),
      },
    });
  } catch (erro) {
    next(erro);
  }
});

/* ------------------------------------------------------------------ */
/* GET /api/companies -> busca paginada                                */
/* ------------------------------------------------------------------ */
router.get('/companies', async (req, res, next) => {
  try {
    const pagina = Math.max(inteiro(req.query.page, 1), 1);
    const limite = Math.min(Math.max(inteiro(req.query.limit, 25), 1), 1000);
    const filtro = construirFiltro(req.query);
    const ordenacao = construirOrdenacao(req.query.ordenar);

    const [total, docs] = await Promise.all([
      Company.countDocuments(filtro),
      Company.find(filtro, PROJECAO_LISTA)
        .sort(ordenacao)
        .skip((pagina - 1) * limite)
        .limit(limite)
        .lean(),
    ]);

    res.json({
      ok: true,
      page: pagina,
      limit: limite,
      total,
      pages: Math.max(Math.ceil(total / limite), 1),
      data: docs.map((d) => ({ ...d, cnpjFormatado: d.cnpjFormatado || formatarCnpj(d.cnpj) })),
    });
  } catch (erro) {
    next(erro);
  }
});

/* ------------------------------------------------------------------ */
/* GET /api/companies/stream -> TODAS as empresas em NDJSON (stream)   */
/* ------------------------------------------------------------------ */
router.get('/companies/stream', async (req, res, next) => {
  let cursor = null;
  try {
    const filtro = construirFiltro(req.query);
    const ordenacao = construirOrdenacao(req.query.ordenar);
    const total = await Company.countDocuments(filtro);

    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('X-Total-Rows', String(total));
    // no-transform desliga o middleware de compressao: o stream vai direto ao socket
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');

    // Envia o total como primeira linha para o frontend montar o progresso
    res.write(`${JSON.stringify({ __meta: true, total })}\n`);

    cursor = Company.find(filtro, PROJECAO_LISTA).sort(ordenacao).lean().cursor();

    let abortado = false;
    res.on('close', () => {
      abortado = true;
      if (cursor) cursor.close().catch(() => {});
    });

    let enviados = 0;
    for await (const doc of cursor) {
      if (abortado) break;
      const linha = `${JSON.stringify({ ...doc, cnpjFormatado: doc.cnpjFormatado || formatarCnpj(doc.cnpj) })}\n`;
      if (!res.write(linha)) await once(res, 'drain');
      enviados += 1;
    }

    if (!abortado) res.end();
  } catch (erro) {
    if (cursor) { try { await cursor.close(); } catch (_) { /* ignore */ } }
    if (res.headersSent) {
      res.end();
    } else {
      next(erro);
    }
  }
});

/* ------------------------------------------------------------------ */
/* GET /api/companies/:cnpj -> detalhe completo                        */
/* ------------------------------------------------------------------ */
router.get('/companies/:cnpj', async (req, res, next) => {
  try {
    const cnpj = String(req.params.cnpj).replace(/\D/g, '');
    if (!cnpj) return res.status(400).json({ ok: false, error: 'CNPJ_INVALIDO' });

    const empresa = await Company.findOne({ cnpj }).lean();
    if (!empresa) return res.status(404).json({ ok: false, error: 'NAO_ENCONTRADO' });

    return res.json({ ok: true, data: empresa });
  } catch (erro) {
    return next(erro);
  }
});

/* ------------------------------------------------------------------ */
/* GET /api/stats -> KPIs e graficos do dashboard                      */
/* ------------------------------------------------------------------ */
router.get('/stats', async (req, res, next) => {
  try {
    const filtro = construirFiltro(req.query);

    const [total, porSituacao, porTipo, porMunicipio, porAno, porPorte, socios, capital, porCnae] = await Promise.all([
      Company.countDocuments(filtro),
      Company.aggregate([{ $match: filtro }, { $group: { _id: '$situacao', total: { $sum: 1 } } }, { $sort: { total: -1 } }]),
      Company.aggregate([{ $match: filtro }, { $unwind: '$tipos' }, { $group: { _id: '$tipos', total: { $sum: 1 } } }, { $sort: { total: -1 } }, { $limit: 12 }]),
      Company.aggregate([
        { $match: filtro },
        { $group: { _id: { m: '$endereco.municipio', uf: '$endereco.uf' }, total: { $sum: 1 } } },
        { $sort: { total: -1 } },
        { $limit: 10 },
      ]),
      Company.aggregate([
        { $match: { ...filtro, dataAbertura: { ...(filtro.dataAbertura || {}), $ne: null } } },
        { $group: { _id: { $year: '$dataAbertura' }, total: { $sum: 1 } } },
        { $match: { _id: { $gte: 1900 } } },
        { $sort: { _id: 1 } },
      ]),
      Company.aggregate([{ $match: filtro }, { $group: { _id: '$porte', total: { $sum: 1 } } }, { $sort: { total: -1 } }]),
      Company.aggregate([
        { $match: filtro },
        { $group: { _id: null, total: { $sum: '$sociosCount' }, comSocios: { $sum: { $cond: [{ $gt: ['$sociosCount', 0] }, 1, 0] } } } },
      ]),
      Company.aggregate([{ $match: filtro }, { $group: { _id: null, soma: { $sum: '$capitalSocial' }, media: { $avg: '$capitalSocial' }, max: { $max: '$capitalSocial' } } }]),
      Company.aggregate([
        { $match: { ...filtro, cnaePrincipal: { $ne: null } } },
        { $group: { _id: { codigo: '$cnaePrincipalCodigo', nome: '$cnaePrincipal' }, total: { $sum: 1 } } },
        { $sort: { total: -1 } },
        { $limit: 8 },
      ]),
    ]);

    const situacoes = porSituacao.reduce((acc, s) => ({ ...acc, [s._id || 'NAO INFORMADA']: s.total }), []);

    res.json({
      ok: true,
      data: {
        kpis: {
          total,
          ativas: situacoes.ATIVA || 0,
          baixadas: situacoes.BAIXADA || 0,
          suspensas: situacoes.SUSPENSA || 0,
          inaptas: situacoes.INAPTA || 0,
          nulas: situacoes.NULA || 0,
          totalSocios: socios[0]?.total || 0,
          empresasComSocios: socios[0]?.comSocios || 0,
          capitalTotal: capital[0]?.soma || 0,
          capitalMedio: Math.round(capital[0]?.media || 0),
          capitalMaximo: capital[0]?.max || 0,
          mei: porTipo.find((t) => t._id === 'MEI')?.total || 0,
          ltda: porTipo.find((t) => t._id === 'LTDA')?.total || 0,
          me: porTipo.find((t) => t._id === 'ME')?.total || 0,
        },
        porSituacao: porSituacao.map((s) => ({ nome: s._id || 'NAO INFORMADA', total: s.total })),
        porTipo: porTipo.map((t) => ({ nome: t._id, total: t.total })),
        porMunicipio: porMunicipio.map((m) => ({ nome: m._id?.m || 'Nao informado', uf: m._id?.uf || '', total: m.total })),
        porAno: porAno.map((a) => ({ ano: a._id, total: a.total })),
        porPorte: porPorte.map((p) => ({ nome: p._id || 'NAO INFORMADO', total: p.total })),
        porCnae: porCnae.map((c) => ({ codigo: c._id?.codigo || '', nome: c._id?.nome || 'Nao informado', total: c.total })),
      },
    });
  } catch (erro) {
    next(erro);
  }
});

/* ------------------------------------------------------------------ */
/* GET /api/export -> EXPORTACAO COMPLETA (streaming, sem limite)      */
/*                                                                     */
/*  formato: csv | json | ndjson | csv.gz | json.gz | ndjson.gz        */
/*  layout : empresa (1 linha por CNPJ) | socio (1 linha por socio)    */
/*  max    : 0 = TODAS (padrao)                                        */
/* ------------------------------------------------------------------ */
router.get('/export', async (req, res, next) => {
  let cursor = null;
  try {
    const formatoBruto = String(req.query.formato || 'csv').toLowerCase();
    const gzip = formatoBruto.endsWith('.gz');
    const formato = formatoBruto.replace('.gz', '');
    if (!['csv', 'json', 'ndjson'].includes(formato)) {
      return res.status(400).json({ ok: false, error: 'FORMATO_INVALIDO', message: 'Use csv, json, ndjson (opcionalmente .gz).' });
    }

    const layout = String(req.query.layout || 'empresa').toLowerCase() === 'socio' ? 'socio' : 'empresa';
    const max = inteiro(req.query.max, 0); // 0 = sem limite
    const filtro = construirFiltro(req.query);
    const ordenacao = construirOrdenacao(req.query.ordenar);

    const totalEmpresas = await Company.countDocuments(filtro);
    const efetivo = max > 0 ? Math.min(max, totalEmpresas) : totalEmpresas;

    const nomeBase = `empresas-${(req.query.uf || 'br').toUpperCase()}${req.query.municipio ? '-' + String(req.query.municipio).replace(/\W+/g, '_') : ''}-${new Date().toISOString().slice(0, 10)}`;

    res.setHeader('Content-Disposition', `attachment; filename="${nomeBase}.${layout === 'socio' ? 'socios.' : ''}${formato}${gzip ? '.gz' : ''}"`);
    res.setHeader('X-Total-Rows', String(efetivo));
    res.setHeader('X-Total-Partners', String(layout === 'socio' ? 'variavel' : ''));
    // no-transform desliga o middleware de compressao (evita listeners de drain acumulados)
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Content-Type', {
      csv: 'text/csv; charset=utf-8',
      json: 'application/json; charset=utf-8',
      ndjson: 'application/x-ndjson; charset=utf-8',
    }[formato]);

    let saida = res;
    if (gzip) {
      const gz = zlib.createGzip({ level: 6 });
      gz.pipe(res);
      saida = gz;
    }

    const escrever = async (texto) => {
      if (!saida.write(texto)) await once(saida, 'drain');
    };

    let abortado = false;
    res.on('close', () => {
      abortado = true;
      if (cursor) cursor.close().catch(() => {});
      if (saida !== res && typeof saida.destroy === 'function') saida.destroy();
    });

    if (formato === 'csv') await escrever('\uFEFF' + exporters.cabecalho(layout));
    if (formato === 'json') await escrever('[\n');

    cursor = Company.find(filtro).sort(ordenacao).lean().cursor();
    if (efetivo !== totalEmpresas) cursor = cursor.limit(efetivo);

    let empresas = 0;
    let linhas = 0;

    for await (const doc of cursor) {
      if (abortado) break;

      if (formato === 'csv') {
        await escrever(exporters.linhasDe(doc, layout).join(''));
      } else if (formato === 'ndjson') {
        await escrever(`${JSON.stringify({ ...doc, cnpjFormatado: doc.cnpjFormatado || formatarCnpj(doc.cnpj) })}\n`);
      } else {
        await escrever((empresas === 0 ? '' : ',\n') + JSON.stringify(doc));
      }

      empresas += 1;
      linhas += exporters.contarLinhas(doc, layout);
    }

    if (formato === 'json' && !abortado) await escrever('\n]\n');

    if (abortado) return undefined;

    if (gzip) {
      saida.end();
      return undefined;
    }
    console.log(`[export] ${formato}${gzip ? '.gz' : ''} layout=${layout} empresas=${empresas} linhas=${linhas}`);
    return res.end();
  } catch (erro) {
    if (cursor) { try { await cursor.close(); } catch (_) { /* ignore */ } }
    if (res.headersSent) return res.end();
    return next(erro);
  }
});

/* ------------------------------------------------------------------ */
/* GET /api/socios?q=... -> busca direta por nome do socio             */
/* ------------------------------------------------------------------ */
router.get('/socios', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ ok: false, error: 'INFORME_O_NOME_DO_SOCIO' });

    const { normalizar, escapeRegex } = require('../lib/normalize');
    const filtro = construirFiltro(req.query);
    const rx = new RegExp(escapeRegex(normalizar(q)), 'i');

    const limite = Math.min(inteiro(req.query.limit, 50), 1000);
    const docs = await Company.find(
      { ...filtro, sociosNomes: rx },
      { cnpj: 1, cnpjFormatado: 1, razaoSocial: 1, situacao: 1, 'endereco.uf': 1, 'endereco.municipio': 1, socios: 1 }
    ).limit(limite).lean();

    const socios = [];
    for (const d of docs) {
      for (const s of d.socios || []) {
        if (normalizar(s.nome).includes(normalizar(q))) {
          socios.push({
            nome: s.nome,
            documento: s.documento,
            qualificacao: s.qualificacao,
            dataEntrada: s.dataEntrada,
            empresa: {
              cnpj: d.cnpjFormatado || formatarCnpj(d.cnpj),
              razaoSocial: d.razaoSocial,
              situacao: d.situacao,
              municipio: d.endereco?.municipio,
              uf: d.endereco?.uf,
            },
          });
        }
      }
    }

    return res.json({ ok: true, total: socios.length, data: socios });
  } catch (erro) {
    return next(erro);
  }
});

/* ================================================================== */
/* PREPARACAO AUTOMATICA DA BASE                                       */
/* O usuario escolhe estado + cidade e o sistema importa o que falta.  */
/* ================================================================== */
const importador = require('../services/importador');
const ImportJob = require('../models/ImportJob');

/** Versao enxuta do job, para o dashboard acompanhar */
function resumoJob(job) {
  if (!job) return null;
  const j = job.toJSON ? job.toJSON() : job;
  return {
    id: String(j._id || j.id || ''),
    uf: j.uf,
    municipio: j.municipio || '',
    escopo: j.escopo || 'estado',
    origem: j.origem || 'manual',
    status: j.status,
    fase: j.fase,
    faseNumero: j.faseNumero,
    totalFases: j.totalFases,
    progresso: j.progresso || {},
    log: (j.log || []).slice(-40),
    erro: j.erro,
    iniciadoEm: j.iniciadoEm,
    resultado: j.resultado,
  };
}

function autoImportLigado() {
  return String(process.env.AUTO_IMPORT || 'true').toLowerCase() !== 'false';
}

/* ------------------------------------------------------------------ */
/* GET /api/status?uf=ES&municipio=Vitoria                             */
/* Diz se a base ja tem os dados pedidos e se precisa importar.        */
/* ------------------------------------------------------------------ */
router.get('/status', async (req, res, next) => {
  try {
    const uf = String(req.query.uf || '').toUpperCase().trim();
    const municipio = String(req.query.municipio || '').trim();

    const filtroCidade = {};
    if (uf) filtroCidade['endereco.uf'] = uf;
    if (municipio) filtroCidade['endereco.municipio'] = municipio;

    const [total, totalUf] = await Promise.all([
      Company.countDocuments(filtroCidade),
      uf ? Company.countDocuments({ 'endereco.uf': uf }) : Company.estimatedDocumentCount(),
    ]);

    // Historico de importacoes concluidas define o que ja foi carregado
    const [jobEstado, jobCidade] = await Promise.all([
      uf ? ImportJob.findOne({ uf, escopo: 'estado', status: 'concluido' }).sort({ finalizadoEm: -1 }).lean() : null,
      uf && municipio ? ImportJob.findOne({ uf, municipio, status: 'concluido' }).sort({ finalizadoEm: -1 }).lean() : null,
    ]);

    const estadoCarregado = !!jobEstado;
    const cidadeCarregada = estadoCarregado || !!jobCidade;

    let precisaImportar = false;
    let motivo = '';
    if (total > 0) {
      motivo = 'dados ja disponiveis';
    } else if (!uf) {
      motivo = 'informe um estado para preparar a base';
    } else if (municipio) {
      precisaImportar = !cidadeCarregada;
      motivo = precisaImportar ? `a cidade ${municipio} ainda nao foi importada` : 'cidade importada, sem empresas';
    } else {
      precisaImportar = !estadoCarregado && totalUf === 0;
      motivo = precisaImportar ? `o estado ${uf} ainda nao foi importado` : 'estado ja disponivel';
    }

    if (precisaImportar && !autoImportLigado()) {
      precisaImportar = false;
      motivo = 'importacao automatica desligada (AUTO_IMPORT=false)';
    }

    const jobId = importador.jobAtivo();
    const job = jobId ? await importador.obterJob(jobId) : null;

    res.json({
      ok: true,
      data: {
        uf,
        municipio,
        total,
        totalUf,
        precisaImportar,
        motivo,
        autoImport: autoImportLigado(),
        escopo: municipio ? 'municipio' : 'estado',
        job: resumoJob(job),
      },
    });
  } catch (erro) {
    next(erro);
  }
});

/* ------------------------------------------------------------------ */
/* POST /api/preparar  { uf, municipio }                               */
/* Dispara a importacao do que falta, sem o usuario precisar fazer nada */
/* ------------------------------------------------------------------ */
router.post('/preparar', async (req, res, next) => {
  try {
    if (!autoImportLigado()) {
      return res.status(403).json({
        ok: false,
        error: 'AUTO_IMPORT_DESLIGADO',
        message: 'A importacao automatica esta desligada (AUTO_IMPORT=false). Use o painel ADMIN.',
      });
    }

    const uf = String((req.body && req.body.uf) || req.query.uf || '').toUpperCase().trim();
    const municipio = String((req.body && req.body.municipio) || req.query.municipio || '').trim();

    if (!uf) {
      return res.status(400).json({
        ok: false,
        error: 'UF_OBRIGATORIA',
        message: 'Escolha um estado para o sistema preparar a base.',
      });
    }

    // Ja existe uma importacao rodando? Aproveita ela em vez de criar outra.
    const jaRodando = importador.jobAtivo();
    if (jaRodando) {
      return res.json({ ok: true, data: { jobId: jaRodando, jaRodando: true } });
    }

    const job = await importador.iniciarJob({ uf, municipio, origem: 'automatico', remoto: true });
    return res.json({ ok: true, data: { jobId: String(job._id), jaRodando: false } });
  } catch (erro) {
    if (erro.message === 'JA_EXISTE_IMPORTACAO_EM_ANDAMENTO') {
      const id = importador.jobAtivo();
      return res.json({ ok: true, data: { jobId: id, jaRodando: true } });
    }
    return next(erro);
  }
});

module.exports = router;
