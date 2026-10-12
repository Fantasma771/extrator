'use strict';

/**
 * Servico de importacao dos Dados Abertos do CNPJ (Receita Federal).
 *
 * Funciona em dois modos:
 *   - LOCAL  : le os arquivos de uma pasta (./data) — para rodar na sua maquina
 *   - REMOTO : baixa e descompacta em streaming direto da internet — usado
 *              quando a importacao roda dentro do Render (disco efemero)
 *
 * Expoe tambem um gerenciador de "jobs" para o painel de administracao do
 * dashboard (iniciar / acompanhar / cancelar / historico).
 */

const Company = require('../models/Company');
const Municipio = require('../models/Municipio');
const ImportJob = require('../models/ImportJob');
const { resolverFontes, lerFonte, baseUrl } = require('../lib/fontes');
const {
  normalizar,
  formatarCnpj,
  parseData,
  parseNumero,
  apenasDigitos,
  emLotes,
} = require('../lib/normalize');
const { SITUACOES, PORTES, NATUREZAS, QUALIFICACOES, UF_CODES } = require('../lib/tables');
const { lerTabela, listarFontes } = require('../lib/csv');

/* ------------------------------------------------------------------ */
/* Helpers de transformacao                                            */
/* ------------------------------------------------------------------ */
function tipoPorNatureza(codigo) {
  const n = NATUREZAS[String(codigo || '').trim()];
  return n ? n.tipo : 'OUTROS';
}

function descNatureza(codigo, mapa) {
  const c = String(codigo || '').trim();
  return mapa.get(c) || NATUREZAS[c]?.descricao || (c ? `Natureza ${c}` : '');
}

function tipoDocumentoSocio(identificador) {
  if (identificador === '1') return 'CNPJ';
  if (identificador === '2') return 'CPF';
  if (identificador === '3') return 'ESTRANGEIRO';
  return 'OUTRO';
}

/* ------------------------------------------------------------------ */
/* Tabelas de referencia                                               */
/* ------------------------------------------------------------------ */
async function carregarReferencias({ dataDir, remoto }, log) {
  const naturezas = new Map();
  const qualificacoes = new Map();
  const motivos = new Map();
  const cnaes = new Map();

  const carregar = async (chave, mapa, rotulo) => {
    const fontes = resolverFontes(chave, { dataDir, remoto });
    for (const fonte of fontes) {
      try {
        if (fonte.local) {
          const parcial = await lerTabela(fonte.local);
          parcial.forEach((v, k) => mapa.set(k, v));
        } else {
          await lerFonte(fonte, (campos) => {
            if (campos.length < 2) return;
            const codigo = campos[0].trim();
            const descricao = campos.slice(1).join(' ').trim();
            if (codigo) mapa.set(codigo, descricao);
          });
        }
      } catch (e) {
        log(`[aviso] nao foi possivel carregar ${rotulo} (${fonte.nome}): ${e.message}`);
      }
    }
    log(`[ref] ${rotulo}: ${mapa.size} registros`);
  };

  await carregar('naturezas', naturezas, 'Naturezas');
  await carregar('qualificacoes', qualificacoes, 'Qualificacoes');
  await carregar('motivos', motivos, 'Motivos');
  await carregar('cnaes', cnaes, 'CNAEs');

  return { naturezas, qualificacoes, motivos, cnaes };
}

/* ------------------------------------------------------------------ */
/* Fase 1 - Estabelecimentos                                           */
/* ------------------------------------------------------------------ */
async function importarEstabelecimentos({ dataDir, remoto, uf, batch, limit, cnaes, motivos, municipiosAlvo, nomesMunicipios }, ctl) {
  const fontes = resolverFontes('estabelecimentos', { dataDir, remoto });
  if (!fontes.length) throw new Error('Nenhum arquivo de Estabelecimentos disponivel.');

  ctl.fase('Estabelecimentos', 2, fontes.length);
  const soCidade = municipiosAlvo && municipiosAlvo.size > 0;
  if (soCidade) ctl.log(`Filtrando apenas ${municipiosAlvo.size} municipio(s): ${[...municipiosAlvo].join(', ')}`);

  let buffer = [];
  let processados = 0;
  let importados = 0;
  let ignorados = 0;

  const gravar = async (force = false) => {
    if (!buffer.length) return;
    if (!force && buffer.length < batch) return;
    const ops = buffer.map((doc) => ({
      updateOne: { filter: { cnpj: doc.cnpj }, update: { $set: doc }, upsert: true },
    }));
    await Company.bulkWrite(ops, { ordered: false });
    importados += ops.length;
    buffer = [];
    ctl.progresso({ linhasLidas: processados, gravados: importados, ignorados });
  };

  for (let i = 0; i < fontes.length; i += 1) {
    const fonte = fontes[i];
    ctl.arquivo(fonte.nome, i + 1, fontes.length);
    ctl.log(`Lendo ${fonte.nome}...`);

    await lerFonte(fonte, async (c) => {
      processados += 1;
      if (c.length < 21) return undefined;

      const ufLinha = (c[19] || '').trim().toUpperCase();
      if (uf && ufLinha !== uf) { ignorados += 1; return undefined; }

      const codigoMunicipio = apenasDigitos(c[20]);
      if (soCidade && !municipiosAlvo.has(codigoMunicipio)) { ignorados += 1; return undefined; }
      if (limit && importados + buffer.length >= limit) return undefined;

      const cnpjBasico = apenasDigitos(c[0]).padStart(8, '0');
      const cnpj = `${cnpjBasico}${apenasDigitos(c[1]).padStart(4, '0')}${apenasDigitos(c[2]).padStart(2, '0')}`;

      const situacaoCodigo = apenasDigitos(c[5]).padStart(2, '0');
      const nomeFantasia = (c[4] || '').trim();
      const cnaePrincipalCodigo = apenasDigitos(c[11]);

      buffer.push({
        cnpj,
        cnpjFormatado: formatarCnpj(cnpj),
        cnpjBasico,
        cnpjOrdem: c[1],
        cnpjDv: c[2],
        razaoSocial: '',
        razaoSocialNormalizada: '',
        nomeFantasia,
        nomeFantasiaNormalizado: normalizar(nomeFantasia),
        matrizFilial: c[3] === '1' ? 'MATRIZ' : 'FILIAL',
        situacao: SITUACOES[situacaoCodigo] || 'NAO INFORMADA',
        situacaoCodigo,
        motivoSituacao: motivos.get(apenasDigitos(c[7]).padStart(2, '0')) || '',
        dataSituacao: parseData(c[6]),
        dataAbertura: parseData(c[10]),
        cnaePrincipalCodigo,
        cnaePrincipal: cnaes.get(cnaePrincipalCodigo) || '',
        cnaesSecundarios: (c[12] || '')
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
          .slice(0, 30)
          .map((codigo) => ({ codigo, descricao: cnaes.get(codigo) || '' })),
        endereco: {
          tipoLogradouro: c[13],
          logradouro: c[14],
          numero: c[15],
          complemento: c[16],
          bairro: c[17],
          cep: apenasDigitos(c[18]),
          uf: ufLinha,
          municipio: (nomesMunicipios && nomesMunicipios.get(codigoMunicipio)) || '',
          codigoMunicipio,
          pais: c[9] || 'BRASIL',
          nomeCidadeExterior: c[8],
        },
        contato: { ddd1: c[21], telefone1: c[22], ddd2: c[23], telefone2: c[24], fax: c[26], email: c[27] },
        situacaoEspecial: c[28],
        dataSituacaoEspecial: parseData(c[29]),
        tipos: [],
        socios: [],
        sociosCount: 0,
        atualizadoEm: new Date(),
      });

      if (buffer.length >= batch) await gravar(true);
      return undefined;
    }, { cancelado: ctl.deveCancelar });

    if (ctl.deveCancelar()) break;
  }

  await gravar(true);
  ctl.log(`Estabelecimentos: ${importados} gravados (${processados} linhas lidas, ${ignorados} ignorados por UF/cidade)`);
  return { empresas: importados, importados, lidos: processados, ignorados };
}

/* ------------------------------------------------------------------ */
/* Fase 2 - Empresas (razao social, natureza, capital, porte)           */
/* ------------------------------------------------------------------ */
async function importarEmpresas({ dataDir, remoto, batch, naturezas }, ctl) {
  const fontes = resolverFontes('empresas', { dataDir, remoto });
  if (!fontes.length) { ctl.log('[aviso] Empresas nao encontrado — razao social ficara vazia.'); return { atualizados: 0 }; }

  ctl.fase('Empresas (razao social)', 2, fontes.length);

  let processados = 0;
  let atualizados = 0;
  let buffer = [];

  const gravar = async (force = false) => {
    if (!buffer.length) return;
    if (!force && buffer.length < batch) return;

    const chaves = [...new Set(buffer.map((b) => b.cnpjBasico))];
    const existentes = new Set();
    for (const lote of emLotes(chaves, 5000)) {
      const achados = await Company.distinct('cnpjBasico', { cnpjBasico: { $in: lote } });
      achados.forEach((k) => existentes.add(k));
    }

    const ops = [];
    for (const item of buffer) {
      if (!existentes.has(item.cnpjBasico)) continue;
      ops.push({
        updateMany: {
          filter: { cnpjBasico: item.cnpjBasico },
          update: { $set: item.$set, $addToSet: { tipos: { $each: item.tipos } } },
        },
      });
    }
    if (ops.length) { await Company.bulkWrite(ops, { ordered: false }); atualizados += ops.length; }
    buffer = [];
    ctl.progresso({ linhasLidas: processados, gravados: atualizados });
  };

  for (let i = 0; i < fontes.length; i += 1) {
    ctl.arquivo(fontes[i].nome, i + 1, fontes.length);
    await lerFonte(fontes[i], async (c) => {
      processados += 1;
      if (c.length < 6) return undefined;

      const cnpjBasico = apenasDigitos(c[0]).padStart(8, '0');
      const razaoSocial = (c[1] || '').trim();
      const naturezaCodigo = String(c[2] || '').trim();
      const porteCodigo = apenasDigitos(c[5]).padStart(2, '0');
      const porte = PORTES[porteCodigo] || 'NAO INFORMADO';

      const tipos = new Set([tipoPorNatureza(naturezaCodigo)]);
      if (porte === 'ME' || porte === 'EPP') tipos.add(porte);

      buffer.push({
        cnpjBasico,
        tipos: [...tipos],
        $set: {
          razaoSocial,
          razaoSocialNormalizada: normalizar(razaoSocial),
          naturezaJuridicaCodigo: naturezaCodigo,
          naturezaJuridica: descNatureza(naturezaCodigo, naturezas),
          qualificacaoResponsavel: QUALIFICACOES[apenasDigitos(c[3])] || '',
          capitalSocial: parseNumero(c[4]),
          porteCodigo,
          porte,
          atualizadoEm: new Date(),
        },
      });

      if (buffer.length >= batch) await gravar(true);
      return undefined;
    }, { cancelado: ctl.deveCancelar });

    if (ctl.deveCancelar()) break;
  }

  await gravar(true);
  ctl.log(`Empresas: ${atualizados} registros atualizados (${processados} lidos)`);
  return { atualizados };
}

/* ------------------------------------------------------------------ */
/* Fase 3 - Simples / MEI                                              */
/* ------------------------------------------------------------------ */
async function importarSimples({ dataDir, remoto, batch }, ctl) {
  const fontes = resolverFontes('simples', { dataDir, remoto });
  if (!fontes.length) { ctl.log('[aviso] Simples.zip nao encontrado — MEI/Simples nao serao marcados.'); return { atualizados: 0 }; }

  ctl.fase('Simples Nacional / MEI', 3, fontes.length);

  let processados = 0;
  let atualizados = 0;
  let buffer = [];

  const gravar = async (force = false) => {
    if (!buffer.length) return;
    if (!force && buffer.length < batch) return;

    const chaves = [...new Set(buffer.map((b) => b.cnpjBasico))];
    const existentes = new Set();
    for (const lote of emLotes(chaves, 5000)) {
      const achados = await Company.distinct('cnpjBasico', { cnpjBasico: { $in: lote } });
      achados.forEach((k) => existentes.add(k));
    }

    const ops = [];
    for (const item of buffer) {
      if (!existentes.has(item.cnpjBasico)) continue;
      ops.push({
        updateMany: {
          filter: { cnpjBasico: item.cnpjBasico },
          update: { $set: item.$set, $addToSet: { tipos: { $each: item.tipos } } },
        },
      });
    }
    if (ops.length) { await Company.bulkWrite(ops, { ordered: false }); atualizados += ops.length; }
    buffer = [];
    ctl.progresso({ linhasLidas: processados, gravados: atualizados });
  };

  for (let i = 0; i < fontes.length; i += 1) {
    ctl.arquivo(fontes[i].nome, i + 1, fontes.length);
    await lerFonte(fontes[i], async (c) => {
      processados += 1;
      if (c.length < 5) return undefined;

      const cnpjBasico = apenasDigitos(c[0]).padStart(8, '0');
      const opcaoSimples = String(c[1] || '').trim().toUpperCase() === 'S';
      const opcaoMei = String(c[4] || '').trim().toUpperCase() === 'S';

      buffer.push({
        cnpjBasico,
        tipos: [opcaoMei ? 'MEI' : '', opcaoSimples ? 'SIMPLES NACIONAL' : ''].filter(Boolean),
        $set: {
          'simples.opcaoSimples': opcaoSimples,
          'simples.dataOpcaoSimples': parseData(c[2]),
          'simples.dataExclusaoSimples': parseData(c[3]),
          'simples.opcaoMei': opcaoMei,
          'simples.dataOpcaoMei': parseData(c[5]),
          'simples.dataExclusaoMei': parseData(c[6]),
        },
      });

      if (buffer.length >= batch) await gravar(true);
      return undefined;
    }, { cancelado: ctl.deveCancelar });

    if (ctl.deveCancelar()) break;
  }

  await gravar(true);
  ctl.log(`Simples/MEI: ${atualizados} registros atualizados`);
  return { atualizados };
}

/* ------------------------------------------------------------------ */
/* Fase 4 - Socios (nome completo)                                     */
/* ------------------------------------------------------------------ */
async function importarSocios({ dataDir, remoto, batch, qualificacoes }, ctl) {
  const fontes = resolverFontes('socios', { dataDir, remoto });
  if (!fontes.length) { ctl.log('[aviso] Socios nao encontrado.'); return { atualizados: 0 }; }

  ctl.fase('Socios (nome completo)', 4, fontes.length);

  let processados = 0;
  let atualizados = 0;
  let buffer = [];
  let chaveAtual = null;
  let sociosAtuais = [];

  const descQual = (codigo) => {
    const c = apenasDigitos(codigo).padStart(2, '0');
    return qualificacoes.get(c) || QUALIFICACOES[c] || '';
  };

  const gravar = async (force = false) => {
    if (!buffer.length) return;
    if (!force && buffer.length < batch) return;

    const chaves = buffer.map((b) => b.cnpjBasico);
    const existentes = new Set();
    for (const lote of emLotes(chaves, 5000)) {
      const achados = await Company.distinct('cnpjBasico', { cnpjBasico: { $in: lote } });
      achados.forEach((k) => existentes.add(k));
    }

    const ops = [];
    for (const item of buffer) {
      if (!existentes.has(item.cnpjBasico)) continue;
      ops.push({
        updateMany: {
          filter: { cnpjBasico: item.cnpjBasico },
          update: {
            $set: {
              socios: item.socios,
              sociosCount: item.socios.length,
              sociosNomes: item.socios.map((s) => s.nomeNormalizado),
            },
          },
        },
      });
    }
    if (ops.length) { await Company.bulkWrite(ops, { ordered: false }); atualizados += ops.length; }
    buffer = [];
    ctl.progresso({ linhasLidas: processados, gravados: atualizados });
  };

  const fecharGrupo = async () => {
    if (!chaveAtual || !sociosAtuais.length) return;
    buffer.push({ cnpjBasico: chaveAtual, socios: sociosAtuais });
    if (buffer.length >= batch) await gravar(true);
  };

  for (let i = 0; i < fontes.length; i += 1) {
    ctl.arquivo(fontes[i].nome, i + 1, fontes.length);
    await lerFonte(fontes[i], async (c) => {
      processados += 1;
      if (c.length < 5) return undefined;

      const cnpjBasico = apenasDigitos(c[0]).padStart(8, '0');
      if (cnpjBasico !== chaveAtual) {
        await fecharGrupo();
        chaveAtual = cnpjBasico;
        sociosAtuais = [];
      }

      const nome = (c[2] || '').trim();
      if (!nome) return undefined;

      sociosAtuais.push({
        nome,
        nomeNormalizado: normalizar(nome),
        documento: (c[3] || '').trim(),
        tipoDocumento: tipoDocumentoSocio(c[1]),
        qualificacaoCodigo: apenasDigitos(c[4]).padStart(2, '0'),
        qualificacao: descQual(c[4]),
        dataEntrada: parseData(c[5]),
        pais: c[6] || '',
        representanteLegal: c[7] || '',
        nomeRepresentante: c[8] || '',
        qualificacaoRepresentante: descQual(c[9]),
        faixaEtaria: c[10] || '',
      });
      return undefined;
    }, { cancelado: ctl.deveCancelar });

    if (ctl.deveCancelar()) break;
  }

  await fecharGrupo();
  await gravar(true);
  ctl.log(`Socios: ${atualizados} empresas com quadro societario (${processados} linhas)`);
  return { atualizados };
}

/* ------------------------------------------------------------------ */
/* Fase 5 - Municipios                                                 */
/* ------------------------------------------------------------------ */
async function importarMunicipios({ dataDir, remoto }, ctl) {
  const fontes = resolverFontes('municipios', { dataDir, remoto });
  const mapa = new Map();
  if (!fontes.length) {
    ctl.log('[aviso] Municipios.zip nao encontrado — nomes de municipio ficarao vazios.');
    return { municipios: 0, mapa };
  }

  ctl.fase('Municipios', 1, fontes.length);

  const ops = [];
  for (const fonte of fontes) {
    await lerFonte(fonte, (c) => {
      const codigo = apenasDigitos(c[0]);
      const nome = (c[1] || '').trim();
      if (!codigo || !nome) return;
      mapa.set(codigo, nome);
      ops.push({
        updateOne: {
          filter: { codigo },
          update: { $set: { codigo, nome, nomeNormalizado: normalizar(nome), uf: UF_CODES[codigo.slice(0, 2)] || '' } },
          upsert: true,
        },
      });
    }, { cancelado: ctl.deveCancelar });
  }

  for (const lote of emLotes(ops, 2000)) {
    await Municipio.bulkWrite(lote, { ordered: false });
  }
  ctl.log(`Municipios carregados: ${ops.length}`);

  // Rede de seguranca: se ja existiam empresas importadas antes (de outra
  // execucao), preenche o nome do municipio nelas tambem.
  if (mapa.size) {
    const semNome = await Company.countDocuments({ 'endereco.municipio': { $in: ['', null] } });
    if (semNome > 0) {
      ctl.log(`Preenchendo nome do municipio em ${semNome} empresas ja existentes...`);
      let atualizados = 0;
      const municipios = await Municipio.find({}, { codigo: 1, nome: 1 }).lean();
      for (let i = 0; i < municipios.length; i += 500) {
        const lote = municipios.slice(i, i + 500);
        try {
          const r = await Company.bulkWrite(
            lote.map((m) => ({
              updateMany: { filter: { 'endereco.codigoMunicipio': m.codigo, 'endereco.municipio': '' }, update: { $set: { 'endereco.municipio': m.nome } } },
            })),
            { ordered: false }
          );
          atualizados += r.modifiedCount || 0;
        } catch (_) { /* lotes vazios */ }
        ctl.progresso({ linhasLidas: municipios.length, gravados: i + lote.length });
        if (ctl.deveCancelar()) break;
      }
      ctl.log(`Empresas com municipio preenchido: ${atualizados}`);
    }
  }

  return { municipios: ops.length, mapa };
}

/* ------------------------------------------------------------------ */
/* Execucao completa                                                   */
/* ------------------------------------------------------------------ */
async function executarImportacao(opcoes, ctl) {
  const inicio = Date.now();
  const cfg = {
    // Permite rodar a importacao automatica a partir de arquivos locais
    // (usado em testes e por quem baixou os arquivos antes).
    dataDir: opcoes.dataDir || process.env.RECEITA_DATA_DIR || null,
    remoto: opcoes.remoto !== false,
    uf: (opcoes.uf || '').toUpperCase() || null,
    batch: opcoes.batch || 2000,
    limit: opcoes.limit || 0,
  };
  const cidade = (opcoes.municipio || '').trim();

  ctl.log(`Fonte: ${cfg.dataDir ? `pasta local ${cfg.dataDir}` : baseUrl()}`);
  ctl.log(`UF: ${cfg.uf || 'TODAS (muito pesado!)'} | cidade: ${cidade || 'todas'} | lote: ${cfg.batch}`);

  if (opcoes.drop) {
    ctl.log('Apagando a colecao de empresas (--drop)...');
    await Company.deleteMany({});
  }

  // ------------------------------------------------------------------
  // FASE 1 - Municipios PRIMEIRO: precisamos do mapa codigo->nome tanto
  // para gravar o nome da cidade direto na empresa quanto para descobrir
  // o codigo IBGE da cidade escolhida pelo usuario.
  // ------------------------------------------------------------------
  const refMunicipios = await importarMunicipios(cfg, ctl);
  if (ctl.deveCancelar()) throw new Error('CANCELADO');

  let municipiosAlvo = null;
  if (cidade) {
    municipiosAlvo = await resolverCodigosMunicipio(cfg.uf, cidade);
    if (!municipiosAlvo.size) {
      throw new Error(
        `Nao encontrei o municipio "${cidade}" na base oficial da Receita${cfg.uf ? ` para a UF ${cfg.uf}` : ''}. ` +
        'Confira o nome (ex: "Sao Paulo", "Vitoria", "Belo Horizonte").'
      );
    }
    ctl.log(`Escopo: SOMENTE ${cidade} (codigo ${[...municipiosAlvo].join(', ')})`);
  }

  const refs = await carregarReferencias(cfg, ctl.log);
  if (ctl.deveCancelar()) throw new Error('CANCELADO');

  const r1 = await importarEstabelecimentos(
    { ...cfg, cnaes: refs.cnaes, motivos: refs.motivos, municipiosAlvo, nomesMunicipios: refMunicipios.mapa },
    ctl
  );
  if (ctl.deveCancelar()) throw new Error('CANCELADO');

  await importarEmpresas({ ...cfg, naturezas: refs.naturezas }, ctl);
  if (ctl.deveCancelar()) throw new Error('CANCELADO');

  if (!opcoes.skipSimples) await importarSimples(cfg, ctl);
  if (ctl.deveCancelar()) throw new Error('CANCELADO');

  if (!opcoes.skipSocios) await importarSocios({ ...cfg, qualificacoes: refs.qualificacoes }, ctl);

  ctl.fase('Indices', 5, 5);
  ctl.log('Criando indices...');
  await Company.syncIndexes();
  await Municipio.syncIndexes();

  const porUf = await Company.aggregate([
    { $group: { _id: { uf: '$endereco.uf', m: '$endereco.municipio' }, total: { $sum: 1 } } },
    { $group: { _id: '$_id.uf', municipios: { $sum: 1 }, total: { $sum: '$total' } } },
    { $sort: { total: -1 } },
  ]);

  const empresas = await Company.countDocuments();
  const socios = await Company.aggregate([{ $group: { _id: null, t: { $sum: '$sociosCount' } } }]);

  return {
    empresas,
    socios: socios[0]?.t || 0,
    municipios: r1.importados,
    escopo: cidade ? 'municipio' : 'estado',
    municipiosAlvo: municipiosAlvo ? [...municipiosAlvo] : [],
    duracaoMs: Date.now() - inicio,
    porUf: porUf.map((r) => ({ uf: r._id, municipios: r.municipios, total: r.total })),
  };
}

/**
 * Descobre o(s) codigo(s) IBGE de um municipio pelo nome.
 * Aceita nome exato, sem acento e tambem busca por prefixo.
 */
async function resolverCodigosMunicipio(uf, nome) {
  const alvo = normalizar(nome);
  if (!alvo) return new Set();

  const filtroBase = uf ? { uf } : {};
  const exatos = await Municipio.find({ ...filtroBase, nomeNormalizado: alvo }, { codigo: 1 }).lean();
  if (exatos.length) return new Set(exatos.map((m) => m.codigo));

  // tenta "sao paulo" -> "saopaulo", "vitoria" -> "vitoria"
  const semEspaco = alvo.replace(/\s+/g, '');
  const todos = await Municipio.find(filtroBase, { codigo: 1, nomeNormalizado: 1 }).lean();
  const achados = todos.filter((m) => m.nomeNormalizado.replace(/\s+/g, '') === semEspaco);
  if (achados.length) return new Set(achados.map((m) => m.codigo));

  // ultimo recurso: prefixo (ex: "belo horizonte" -> "belo horizonte")
  const prefixo = todos.filter((m) => m.nomeNormalizado.startsWith(alvo));
  if (prefixo.length && prefixo.length <= 5) return new Set(prefixo.map((m) => m.codigo));

  return new Set();
}

/* ------------------------------------------------------------------ */
/* Gerenciador de jobs (usado pelo painel do dashboard)                */
/* ------------------------------------------------------------------ */
const ativos = new Map(); // id -> { cancelado: boolean }

function jobAtivo() {
  for (const [id] of ativos) return id;
  return null;
}

async function iniciarJob(opcoes = {}) {
  if (ativos.size) throw new Error('JA_EXISTE_IMPORTACAO_EM_ANDAMENTO');

  const cidade = (opcoes.municipio || '').trim();
  const job = await ImportJob.create({
    uf: (opcoes.uf || '').toUpperCase() || 'TODAS',
    municipio: cidade,
    escopo: cidade ? 'municipio' : 'estado',
    origem: opcoes.origem === 'automatico' ? 'automatico' : 'manual',
    opcoes: {
      drop: !!opcoes.drop,
      skipSocios: !!opcoes.skipSocios,
      skipSimples: !!opcoes.skipSimples,
      limit: opcoes.limit || 0,
      remoto: opcoes.remoto !== false,
    },
    status: 'executando',
    fase: 'Iniciando',
    faseNumero: 0,
    totalFases: 5,
  });

  const id = String(job._id);
  const controle = { cancelado: false };
  ativos.set(id, controle);

  let ultimoSalvar = 0;
  let patchPendente = {};
  let logsPendentes = [];
  let ultimoUpdate = Promise.resolve();

  const ctl = {
    deveCancelar: () => controle.cancelado,

    log(mensagem) {
      console.log(`[import ${id}] ${mensagem}`);
      logsPendentes.push(`${new Date().toISOString().slice(11, 19)} ${mensagem}`);
      ctl.flush(true);
    },

    fase(nome, numero, totalArquivos) {
      patchPendente.fase = nome;
      patchPendente.faseNumero = numero;
      patchPendente.totalFases = 5;
      if (totalArquivos) patchPendente['progresso.totalArquivos'] = totalArquivos;
      ctl.flush(true);
    },

    arquivo(nome, numero, total) {
      patchPendente['progresso.arquivo'] = nome;
      patchPendente['progresso.arquivoNumero'] = numero;
      patchPendente['progresso.totalArquivos'] = total;
      ctl.flush(true);
    },

    progresso(dados) {
      if (dados) {
        Object.entries(dados).forEach(([k, v]) => { patchPendente[`progresso.${k}`] = v; });
      }
      ctl.flush(false);
    },

    /** Grava no Mongo (com throttle). Logs nunca sao descartados. */
    flush(forcar) {
      const agora = Date.now();
      const temLog = logsPendentes.length > 0;
      const temPatch = Object.keys(patchPendente).length > 0;
      if (!temLog && !temPatch) return ultimoUpdate;
      if (!forcar && agora - ultimoSalvar < 1200 && logsPendentes.length < 25) return ultimoUpdate;

      ultimoSalvar = agora;
      const update = {};
      if (temPatch) update.$set = { ...patchPendente, atualizadoEm: new Date() };
      if (temLog) {
        update.$push = { log: { $each: logsPendentes, $slice: -150 } };
        logsPendentes = [];
      }
      patchPendente = {};
      ultimoUpdate = ImportJob.updateOne({ _id: id }, update).catch(() => {});
      return ultimoUpdate;
    },
  };

  // Roda em background: a resposta HTTP volta imediatamente
  (async () => {
    try {
      const resultado = await executarImportacao({ ...opcoes, remoto: opcoes.remoto !== false }, ctl);
      await ctl.flush(true);
      await ImportJob.updateOne(
        { _id: id },
        { $set: { status: 'concluido', fase: 'Concluido', progresso: { }, resultado, finalizadoEm: new Date(), atualizadoEm: new Date() },
          $push: { log: { $each: [`${new Date().toISOString().slice(11, 19)} IMPORTACAO CONCLUIDA: ${resultado.empresas} empresas na base`], $slice: -120 } } }
      );
      console.log(`[import ${id}] concluido em ${(resultado.duracaoMs / 60000).toFixed(1)} min`);
    } catch (e) {
      const cancelado = e.message === 'CANCELADO' || controle.cancelado;
      await ctl.flush(true);
      await ImportJob.updateOne(
        { _id: id },
        {
          $set: {
            status: cancelado ? 'cancelado' : 'erro',
            fase: cancelado ? 'Cancelado' : 'Erro',
            erro: cancelado ? null : e.message,
            finalizadoEm: new Date(),
            atualizadoEm: new Date(),
          },
          $push: { log: { $each: [`${new Date().toISOString().slice(11, 19)} ${cancelado ? 'CANCELADO pelo usuario' : `ERRO: ${e.message}`}`], $slice: -120 } },
        }
      );
      console.error(`[import ${id}] ${cancelado ? 'cancelado' : 'erro'}:`, e.message);
    } finally {
      ativos.delete(id);
    }
  })();

  return job;
}

async function obterJob(id) {
  return ImportJob.findById(id).lean();
}

async function listarJobs(limite = 15) {
  return ImportJob.find({}, { log: 0 }).sort({ iniciadoEm: -1 }).limit(limite).lean();
}

async function cancelarJob(id) {
  const controle = ativos.get(String(id));
  if (!controle) return false;
  controle.cancelado = true;
  await ImportJob.updateOne({ _id: id }, { $set: { mensagem: 'Cancelamento solicitado...', atualizadoEm: new Date() } });
  return true;
}

/** Marca como interrompidos os jobs que estavam rodando quando o servidor reiniciou */
async function limparJobsOrfaos() {
  const r = await ImportJob.updateMany(
    { status: 'executando' },
    { $set: { status: 'interrompido', fase: 'Interrompido', erro: 'O servidor reiniciou durante a importacao. Rode novamente: a importacao e idempotente e completa o que falta.', finalizadoEm: new Date() } }
  );
  if (r.modifiedCount) console.log(`[import] ${r.modifiedCount} job(s) marcados como interrompidos`);
}

module.exports = {
  executarImportacao,
  iniciarJob,
  obterJob,
  listarJobs,
  cancelarJob,
  jobAtivo,
  limparJobsOrfaos,
};
