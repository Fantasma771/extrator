/* ==========================================================================
   CNPJ SCANNER · Dashboard
   ========================================================================== */
'use strict';

/* ----------------------------- ESTADO ----------------------------- */
const state = {
  apiBase: localStorage.getItem('cnpj_api_base') || '',
  apiKey: localStorage.getItem('cnpj_api_key') || '',
  adminToken: localStorage.getItem('cnpj_admin_token') || '',
  jobSse: null,
  jobAtual: null,
  meta: null,
  tipos: [],
  page: 1,
  limit: 25,
  ordenar: 'relevancia',
  total: 0,
  pages: 1,
  ultimaConsulta: {},
  charts: {},
  municipiosCache: [],
  acIndex: -1,
  // modo "todas as empresas"
  modoTudo: false,
  dadosCompletos: [],
  paginaTudo: 1,
  limiteTudo: 200000,
  abort: null,
  ocupado: false,
};

/* ----------------------------- HELPERS ----------------------------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const nf = new Intl.NumberFormat('pt-BR');
const fmtNum = (n) => nf.format(Number(n) || 0);

function fmtBytes(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), u.length - 1);
  return `${(b / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

function fmtMoeda(v) {
  const n = Number(v) || 0;
  if (n >= 1e12) return `R$ ${(n / 1e12).toFixed(2)} tri`;
  if (n >= 1e9) return `R$ ${(n / 1e9).toFixed(2)} bi`;
  if (n >= 1e6) return `R$ ${(n / 1e6).toFixed(2)} mi`;
  if (n >= 1e3) return `R$ ${(n / 1e3).toFixed(1)} mil`;
  return `R$ ${nf.format(Math.round(n))}`;
}

function fmtData(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('pt-BR', { timeZone: 'UTC' });
}

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg, tipo = '', ms = 4200) {
  const el = document.createElement('div');
  el.className = `toast ${tipo}`;
  el.textContent = msg;
  $('#toastWrap').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s, transform .3s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(20px)';
    setTimeout(() => el.remove(), 320);
  }, ms);
}

let loaderWatchdog = null;

function loader(on) {
  const el = $('#loader');
  if (!el) return;
  el.hidden = !on;
  // Estilo inline vence qualquer regra de classe — funciona mesmo com CSS em cache
  el.style.display = on ? 'flex' : 'none';
  clearTimeout(loaderWatchdog);
  if (on) {
    // Rede de seguranca: nenhuma tela de carregamento pode ficar presa
    loaderWatchdog = setTimeout(() => {
      if (el.style.display !== 'none') {
        el.hidden = true;
        el.style.display = 'none';
        toast('A operacao demorou demais e foi interrompida. Verifique a conexao com o banco.', 'err', 9000);
      }
    }, 45000);
  }
}

function setStatus(tipo, texto) {
  $('#statusPill').className = `status-pill ${tipo || ''}`;
  $('#statusText').textContent = texto;
}

function setProgresso(pct, texto, detalhe) {
  $('#progressWrap').hidden = false;
  $('#progressFill').style.width = `${Math.max(0, Math.min(100, pct))}%`;
  $('#progressText').textContent = texto || '';
  $('#progressSpeed').textContent = detalhe || '';
}

function esconderProgresso() { $('#progressWrap').hidden = true; $('#progressFill').style.width = '0%'; }

/* ----------------------------- API ----------------------------- */
function montarUrl(caminho, params) {
  const base = state.apiBase ? state.apiBase.replace(/\/+$/, '') : '';
  const url = new URL(`${base}${caminho}`, window.location.origin);
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      if (v === undefined || v === null || v === '') return;
      url.searchParams.set(k, v);
    });
  }
  return url.toString();
}

function cabecalhos() {
  const h = {};
  if (state.apiKey) h['x-api-key'] = state.apiKey;
  return h;
}

/** Combina o signal recebido com um timeout, para nenhuma requisicao travar para sempre */
function comTimeout(signal, ms = 25000) {
  try {
    const t = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : null;
    if (!t) return signal;
    if (signal && AbortSignal.any) return AbortSignal.any([signal, t]);
    return signal || t;
  } catch (_) {
    return signal;
  }
}

async function api(caminho, params, signal, opcoes = {}) {
  let resp;
  const cfg = { headers: { ...cabecalhos() }, signal: comTimeout(signal, opcoes.timeout || 25000) };
  if (opcoes.method) cfg.method = opcoes.method;
  if (opcoes.body !== undefined) {
    cfg.headers['Content-Type'] = 'application/json';
    cfg.body = JSON.stringify(opcoes.body);
  }
  try {
    resp = await fetch(montarUrl(caminho, params), cfg);
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new Error('Tempo esgotado ao falar com a API (25s). O servidor ou o banco podem estar lentos.');
    }
    throw new Error(`Nao foi possivel alcancar a API (${e.message || 'erro de rede'}).`);
  }
  if (resp.status === 401) throw new Error('NAO_AUTORIZADO');
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try { const j = await resp.json(); msg = j.message || j.error || msg; } catch (_) { /* ignore */ }
    throw new Error(msg);
  }
  return resp.json();
}

/* ----------------------------- FILTROS ----------------------------- */
function lerFiltros() {
  return {
    uf: $('#fUf').value,
    municipio: $('#fMunicipio').value.trim(),
    situacao: $('#fSituacao').value,
    ordenar: $('#fOrdenar').value,
    cnae: $('#fCnae').value.trim(),
    natureza: $('#fNatureza').value.trim(),
    aberturaDe: $('#fAberturaDe').value,
    aberturaAte: $('#fAberturaAte').value,
    capitalMin: $('#fCapitalMin').value,
    capitalMax: $('#fCapitalMax').value,
    matrizFilial: $('#fMatrizFilial').value,
    q: $('#fQ').value.trim(),
    tipo: state.tipos.join(','),
    somenteComSocios: $('#fSomenteComSocios').checked ? 'true' : '',
    somenteMei: $('#fSomenteMei').checked ? 'true' : '',
    somenteSimples: $('#fSomenteSimples').checked ? 'true' : '',
  };
}

function descreverAlvo(f) {
  const partes = [];
  if (f.municipio) partes.push(f.municipio);
  if (f.uf) partes.push(f.uf);
  if (state.tipos.length) partes.push(state.tipos.join('/'));
  if (f.situacao) partes.push(f.situacao);
  return partes.length ? partes.join(' · ') : 'todos os filtros atuais';
}

/* ---------------------- PREPARACAO AUTOMATICA DA BASE ---------------------- */
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const prep = { resolver: null, rejeitar: null, rodando: false };

function abrirPrep(titulo, sub, qtd) {
  $('#prepTitulo').textContent = titulo;
  $('#prepSub').textContent = sub;
  $('#prepLog').textContent = '';
  $('#prepStats').innerHTML = '';
  $('#prepFill').style.width = '0%';
  $('#prepFase').textContent = 'aguardando voce iniciar...';
  $('#prepTempo').textContent = '';
  const input = $('#prepQtd');
  if (input) input.value = qtd ? String(qtd) : '';
  $('#prepQtdBox').hidden = false;
  $('#btnPrepIniciar').hidden = false;
  $('#btnPrepIniciar').disabled = false;
  $('#btnPararPrep').hidden = true;
  $('#btnPararPrep').disabled = false;
  $('#btnFecharPrep').textContent = 'Fechar';
  const el = $('#prepOverlay');
  el.hidden = false;
  el.style.display = 'flex';
}

function modoPrepRodando() {
  $('#prepQtdBox').hidden = true;
  $('#btnPrepIniciar').hidden = true;
  $('#btnPararPrep').hidden = false;
  $('#btnPararPrep').disabled = false;
  $('#btnFecharPrep').textContent = 'Fechar (continua)';   
}

function fecharPrep() {
  const el = $('#prepOverlay');
  if (!el) return;
  el.hidden = true;
  el.style.display = 'none';
  prep.resolver = null;
  prep.rejeitar = null;
  prep.rodando = false;
}

function renderPrep(job, inicio) {
  if (!job) return;
  const p = job.progresso || {};
  const fracao = (job.faseNumero || 0) / (job.totalFases || 6);
  const dentro = p.totalArquivos ? (p.arquivoNumero || 0) / p.totalArquivos : 0;
  const pct = Math.min(fracao * 80 + dentro * 20, 99);
  $('#prepFill').style.width = `${pct.toFixed(0)}%`;
  $('#prepFase').textContent = `${job.fase || 'iniciando'}${p.arquivo ? ` · ${p.arquivo}` : ''}`;

  const desde = new Date(job.iniciadoEm || inicio || Date.now()).getTime();
  const seg = Math.max(Math.round((Date.now() - desde) / 1000), 0);
  $('#prepTempo').textContent = seg < 60 ? `${seg}s` : `${Math.floor(seg / 60)}min ${seg % 60}s`;

  const limite = job.limite ? ` · Limite: <b>${fmtNum(job.limite)}</b>` : ' · Limite: <b>todas</b>';
  $('#prepStats').innerHTML =
    `Linhas lidas: <b>${fmtNum(p.linhasLidas || 0)}</b> · Empresas gravadas: <b>${fmtNum(p.gravados || 0)}</b>${limite}`;
  $('#prepLog').textContent = (job.log || []).join('\n');
  $('#prepLog').scrollTop = $('#prepLog').scrollHeight;
}

/** Espera o usuario clicar em IMPORTAR AGORA e devolve a quantidade escolhida */
function esperarInicioPrep() {
  return new Promise((resolve, reject) => {
    prep.resolver = (valor) => resolve(valor);
    prep.rejeitar = () => reject(new Error('IMPORTACAO_CANCELADA'));
  });
}

async function pararImportacaoPrep() {
  try {
    $('#btnPararPrep').disabled = true;
    await api('/api/parar', null, null, { method: 'POST', timeout: 20000 });
    toast('Cancelamento solicitado — parando agora.', '', 5000);
    $('#prepFase').textContent = 'cancelando...';
  } catch (e) {
    $('#btnPararPrep').disabled = false;
    toast(`Falha ao parar: ${e.message}`, 'err');
  }
}

/** Acompanha a importacao por polling ate terminar, cancelar ou dar erro */
async function acompanharImportacao(filtros, alvo, inicio) {
  prep.rodando = true;
  for (let i = 0; i < 7200; i += 1) {
    await dormir(3000);
    let s;
    try {
      s = await api('/api/status', { uf: filtros.uf, municipio: filtros.municipio });
    } catch (_) {
      continue; // servidor reiniciando: tenta de novo
    }
    if (s.data.job) renderPrep(s.data.job, inicio);

    if (!s.data.precisaImportar) {
      fecharPrep();
      toast(`Base de ${alvo} pronta! Carregando os resultados...`, 'ok', 6000);
      return true;
    }
    if (s.data.job && s.data.job.status !== 'executando') {
      const j = s.data.job;
      fecharPrep();
      if (j.status === 'cancelado') throw new Error('IMPORTACAO_CANCELADA');
      throw new Error(j.erro || `A importacao de ${alvo} terminou sem gravar dados.`);
    }
  }

  fecharPrep();
  throw new Error('A importacao esta demorando mais que o esperado. Acompanhe pelo painel ADMIN.');
}

/**
 * Garante que a base tem os dados do estado/cidade escolhidos.
 * Se nao tiver, abre o painel de importacao: o usuario escolhe a QUANTIDADE,
 * clica em IMPORTAR AGORA e pode clicar em PARAR a qualquer momento.
 */
async function garantirBase(filtros) {
  if (!filtros.uf && !filtros.municipio) return true;

  let st;
  try {
    st = await api('/api/status', { uf: filtros.uf, municipio: filtros.municipio });
  } catch (e) {
    console.warn('[status]', e.message);
    return true; // se o status falhar, segue com a busca normal
  }
  if (!st.data.precisaImportar) return true;

  const alvo = filtros.municipio ? `${filtros.municipio}/${filtros.uf}` : filtros.uf;
  const qtdSugerida = Number(($('#fQtd') && $('#fQtd').value) || 0) || 0;

  // Se ja existe uma importacao rodando, apenas acompanha (com botao PARAR)
  if (st.data.job && st.data.job.status === 'executando') {
    abrirPrep(
      `Preparando ${alvo}...`,
      'Ja existe uma importacao em andamento para a base. Acompanhe abaixo ou clique em PARAR para cancelar.',
      ''
    );
    modoPrepRodando();
    loader(false);
    return acompanharImportacao(filtros, alvo, Date.now());
  }

  // Mostra o painel pedindo a quantidade e esperando o usuario iniciar
  abrirPrep(
    `Preparando ${alvo}...`,
    `Primeira busca em ${alvo}: o sistema baixa os dados oficiais (espelho CDN, muito mais rapido) e grava no banco. ` +
    'Isso roda no servidor. Escolha a quantidade de empresas e clique em IMPORTAR AGORA.',
    qtdSugerida
  );
  loader(false);

  let qtd;
  try {
    qtd = await esperarInicioPrep();
  } catch (_) {
    fecharPrep();
    throw new Error('IMPORTACAO_CANCELADA');
  }

  modoPrepRodando();
  $('#prepFase').textContent = 'iniciando...';
  $('#prepFill').style.width = '2%';

  try {
    const r = await api('/api/preparar', null, null, {
      method: 'POST',
      body: { uf: filtros.uf, municipio: filtros.municipio, limit: qtd },
      timeout: 30000,
    });
    if (!(r.data && r.data.jobId)) throw new Error('Nao foi possivel iniciar a importacao.');
  } catch (e) {
    fecharPrep();
    throw e;
  }

  return acompanharImportacao(filtros, alvo, Date.now());
}

/* ----------------------------- BUSCA ----------------------------- */
async function buscar(resetPagina = true, permitirImportar = false) {
  if (resetPagina) state.page = 1;
  loader(true);

  try {
    sairModoTudo(false);
    const filtros = lerFiltros();
    state.ultimaConsulta = filtros;
    state.ordenar = filtros.ordenar;

    // 1) Se a base ainda nao tem esses dados, importa automaticamente
    //    (somente quando o usuario pediu a busca explicitamente)
    if (permitirImportar) await garantirBase(filtros);

    // 2) Busca normal
    const params = { ...filtros, page: state.page, limit: state.limit };

    const [res, stats, contagem] = await Promise.all([
      api('/api/companies', params),
      api('/api/stats', filtros),
      api('/api/count', filtros),
    ]);

    state.total = res.total;
    state.pages = res.pages;
    state.page = res.page;

    renderKPIs(stats.data.kpis);
    renderCharts(stats.data);
    renderTabela(res.data);
    renderPaginacao();
    renderContagem(contagem.data, filtros);
    setStatus('ok', 'Base conectada');
  } catch (e) {
    if (e.message === 'IMPORTACAO_CANCELADA') { setStatus('', 'Importacao cancelada'); toast('Importacao cancelada. Ajuste os filtros ou tente novamente.', '', 6000); }
    else if (e.message === 'NAO_AUTORIZADO') { setStatus('err', 'Chave invalida'); toast('Chave de API invalida. Abra as Configuracoes.', 'err'); }
    else if (String(e.message).includes('BANCO_DESCONECTADO')) { setStatus('err', 'Banco offline'); toast('MongoDB desconectado. Verifique MONGODB_URI.', 'err'); }
    else { setStatus('err', 'Erro na busca'); toast(`Erro: ${e.message}`, 'err', 9000); }
    renderTabela([]);
  } finally {
    fecharPrep();
    loader(false);
  }
}

/* ----------------------------- CONTAGEM EXATA ----------------------------- */
function renderContagem(c, filtros) {
  $('#scanTotal').textContent = fmtNum(c.total);
  $('#scanTotalLbl').textContent = c.total === 1 ? 'empresa encontrada' : 'empresas encontradas';
  $('#scanSub').innerHTML = `
    Alvo: <b style="color:var(--gold-light)">${esc(descreverAlvo(filtros))}</b><br />
    ${fmtNum(c.empresasComSocios)} com socios · ${fmtNum(c.totalSocios)} socios no total<br />
    ${c.municipios.length ? `Municipios no resultado: ${c.municipios.slice(0, 6).map((m) => `${esc(m.nome)} (${fmtNum(m.total)})`).join(', ')}${c.municipios.length > 6 ? ` +${c.municipios.length - 6}` : ''}` : ''}
  `;

  const badge = $('#scanBadge');
  if (!filtros.municipio && !filtros.uf && !filtros.q && !state.tipos.length) {
    badge.className = 'scan-badge warn';
    badge.textContent = 'sem filtro — base inteira';
  } else if (!filtros.municipio) {
    badge.className = 'scan-badge warn';
    badge.textContent = 'escopo estadual';
  } else {
    badge.className = 'scan-badge ok';
    badge.textContent = `${c.total} em ${filtros.municipio}`;
  }
}

/* ----------------------------- KPIs ----------------------------- */
function renderKPIs(k) {
  $('#kpiTotal').textContent = fmtNum(k.total);
  $('#kpiAtivas').textContent = fmtNum(k.ativas);
  $('#kpiBaixadas').textContent = fmtNum(k.baixadas);
  $('#kpiMei').textContent = fmtNum(k.mei);
  $('#kpiLtda').textContent = fmtNum(k.ltda);
  $('#kpiSocios').textContent = fmtNum(k.totalSocios);
  $('#kpiCapital').textContent = fmtMoeda(k.capitalTotal);
  $('#kpiCapitalMedio').textContent = fmtMoeda(k.capitalMedio);
  $('#badgeCount').textContent = fmtNum(k.total);
  $('#footerTotal').textContent = `${fmtNum(k.total)} empresas no resultado atual`;
}

/* ----------------------------- GRAFICOS ----------------------------- */
const CORES = { gold: '#d4af37', goldLight: '#f7e28b', green: '#3ddc84', red: '#ff5f5f', amber: '#ffb020', blue: '#5fd0ff', purple: '#c9a2ff', gray: '#6f6a5e' };
const PALETA = [CORES.gold, CORES.blue, CORES.green, CORES.purple, CORES.amber, CORES.red, CORES.goldLight, CORES.gray];
const CORES_SITUACAO = { ATIVA: CORES.green, BAIXADA: CORES.red, SUSPENSA: CORES.amber, INAPTA: '#ff9f43', NULA: '#9a9a9a' };

function baseOpts() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 650, easing: 'easeOutQuart' },
    plugins: {
      legend: { labels: { color: '#bdb8ab', font: { family: 'Rajdhani', size: 12 }, boxWidth: 12, padding: 12 }, position: 'bottom' },
      tooltip: {
        backgroundColor: '#0d0c0a', borderColor: 'rgba(212,175,55,.5)', borderWidth: 1,
        titleColor: '#f7e28b', bodyColor: '#eae7df', padding: 10,
        titleFont: { family: 'Orbitron', size: 11 }, bodyFont: { family: 'Rajdhani', size: 13 },
      },
    },
  };
}

function gridOpts() {
  const o = baseOpts();
  o.scales = {
    x: { ticks: { color: '#8a8578', font: { family: 'Rajdhani', size: 11 } }, grid: { color: 'rgba(212,175,55,.08)' } },
    y: { ticks: { color: '#8a8578', font: { family: 'Rajdhani', size: 11 } }, grid: { color: 'rgba(212,175,55,.08)' }, beginAtZero: true },
  };
  return o;
}

function destruir(id) { if (state.charts[id]) { state.charts[id].destroy(); delete state.charts[id]; } }

function renderCharts(d) {
  destruir('situacao');
  state.charts.situacao = new Chart($('#chartSituacao'), {
    type: 'doughnut',
    data: {
      labels: d.porSituacao.map((s) => s.nome),
      datasets: [{ data: d.porSituacao.map((s) => s.total), backgroundColor: d.porSituacao.map((s) => CORES_SITUACAO[s.nome] || CORES.gray), borderColor: '#0a0a0c', borderWidth: 2, hoverOffset: 10 }],
    },
    options: { ...baseOpts(), cutout: '62%' },
  });

  destruir('tipos');
  state.charts.tipos = new Chart($('#chartTipos'), {
    type: 'bar',
    data: { labels: d.porTipo.map((t) => t.nome), datasets: [{ label: 'Empresas', data: d.porTipo.map((t) => t.total), backgroundColor: d.porTipo.map((_, i) => PALETA[i % PALETA.length]), borderRadius: 5, borderWidth: 0 }] },
    options: { ...gridOpts(), indexAxis: 'y', plugins: { ...baseOpts().plugins, legend: { display: false } } },
  });

  destruir('municipios');
  state.charts.municipios = new Chart($('#chartMunicipios'), {
    type: 'bar',
    data: { labels: d.porMunicipio.map((m) => `${m.nome}${m.uf ? `/${m.uf}` : ''}`), datasets: [{ label: 'Empresas', data: d.porMunicipio.map((m) => m.total), backgroundColor: 'rgba(212,175,55,.72)', hoverBackgroundColor: CORES.goldLight, borderRadius: 5, borderWidth: 0 }] },
    options: { ...gridOpts(), plugins: { ...baseOpts().plugins, legend: { display: false } } },
  });

  destruir('anos');
  state.charts.anos = new Chart($('#chartAnos'), {
    type: 'line',
    data: { labels: d.porAno.map((a) => a.ano), datasets: [{ label: 'Aberturas', data: d.porAno.map((a) => a.total), borderColor: CORES.gold, backgroundColor: 'rgba(212,175,55,.18)', fill: true, tension: 0.35, pointRadius: 2.5, pointBackgroundColor: CORES.goldLight, borderWidth: 2 }] },
    options: { ...gridOpts(), plugins: { ...baseOpts().plugins, legend: { display: false } } },
  });

  destruir('porte');
  state.charts.porte = new Chart($('#chartPorte'), {
    type: 'polarArea',
    data: { labels: d.porPorte.map((p) => p.nome), datasets: [{ data: d.porPorte.map((p) => p.total), backgroundColor: d.porPorte.map((_, i) => `${PALETA[i % PALETA.length]}bb`), borderColor: '#0a0a0c', borderWidth: 1.5 }] },
    options: { ...baseOpts(), scales: { r: { ticks: { color: '#8a8578', backdropColor: 'transparent', font: { size: 10 } }, grid: { color: 'rgba(212,175,55,.12)' }, angleLines: { color: 'rgba(212,175,55,.12)' } } } },
  });

  destruir('cnae');
  state.charts.cnae = new Chart($('#chartCnae'), {
    type: 'bar',
    data: { labels: d.porCnae.map((c) => (c.nome || '').slice(0, 34)), datasets: [{ label: 'Empresas', data: d.porCnae.map((c) => c.total), backgroundColor: 'rgba(95,208,255,.62)', hoverBackgroundColor: CORES.blue, borderRadius: 5, borderWidth: 0 }] },
    options: { ...gridOpts(), indexAxis: 'y', plugins: { ...baseOpts().plugins, legend: { display: false } } },
  });
}

/* ----------------------------- TABELA ----------------------------- */
function tagsEmpresa(e) {
  const tags = [];
  const tipos = e.tipos || [];
  if (tipos.includes('MEI')) tags.push('<span class="tag tag-mei">MEI</span>');
  if (tipos.includes('ME')) tags.push('<span class="tag">ME</span>');
  if (tipos.includes('EPP')) tags.push('<span class="tag">EPP</span>');
  if (tipos.includes('LTDA')) tags.push('<span class="tag">LTDA</span>');
  if (tipos.includes('SA')) tags.push('<span class="tag tag-sa">S.A.</span>');
  if (tipos.includes('EI')) tags.push('<span class="tag">EI</span>');
  if (tags.length === 0) tags.push('<span class="tag">—</span>');
  return tags.slice(0, 3).join('');
}

function linhaHtml(e) {
  const sit = (e.situacao || 'OUTRA').toUpperCase();
  const classe = ['ATIVA', 'BAIXADA', 'SUSPENSA', 'INAPTA', 'NULA'].includes(sit) ? sit : 'OUTRA';
  return `
    <tr>
      <td>
        <span class="rz">${esc(e.razaoSocial || '(razao social nao importada)')}</span>
        ${e.nomeFantasia ? `<span class="rz-fantasia">${esc(e.nomeFantasia)}</span>` : ''}
      </td>
      <td><span class="cnpj">${esc(e.cnpjFormatado || e.cnpj || '')}</span></td>
      <td><div class="loc">${esc(e.endereco?.municipio || '—')}<small>${esc(e.endereco?.uf || '')} ${e.matrizFilial ? `· ${esc(e.matrizFilial)}` : ''}</small></div></td>
      <td>${tagsEmpresa(e)}</td>
      <td><span class="socios-count">${fmtNum(e.sociosCount || 0)}</span></td>
      <td><span class="situacao s-${classe}">${esc(sit)}</span></td>
      <td>${fmtData(e.dataAbertura)}</td>
      <td><button class="btn-detalhe" data-cnpj="${esc(e.cnpj)}">DETALHES</button></td>
    </tr>`;
}

function renderTabela(lista) {
  const tbody = $('#tbody');
  const vazio = $('#emptyState');

  if (!lista || !lista.length) {
    tbody.innerHTML = '';
    vazio.hidden = false;
    $('#tableStatus').hidden = true;
    return;
  }
  vazio.hidden = true;

  tbody.innerHTML = lista.map(linhaHtml).join('');
  $$('#tbody .btn-detalhe').forEach((b) => b.addEventListener('click', () => abrirDetalhe(b.dataset.cnpj)));

  const st = $('#tableStatus');
  if (state.modoTudo) {
    st.hidden = false;
    st.innerHTML = `◈ <b>MODO COMPLETO ATIVO</b> — ${fmtNum(state.dadosCompletos.length)} de ${fmtNum(state.total)} empresas carregadas na memoria.
      Navegue pelas paginas abaixo; para levar tudo para o Excel/banco use <b>BAIXAR TODAS (CSV)</b>.`;
  } else {
    st.hidden = true;
  }
}

/* ----------------------------- PAGINACAO ----------------------------- */
function renderPaginacao() {
  const el = $('#paginacao');
  const page = state.modoTudo ? state.paginaTudo : state.page;
  const totalItens = state.modoTudo ? state.dadosCompletos.length : state.total;
  const pages = Math.max(Math.ceil(totalItens / state.limit), 1);

  if (pages <= 1) {
    el.innerHTML = `<span class="page-info">${fmtNum(totalItens)} resultados</span>`;
    return;
  }

  const botoes = [];
  const add = (p, label, ativo = false, desabilitado = false) => {
    botoes.push(`<button data-page="${p}" class="${ativo ? 'on' : ''}" ${desabilitado ? 'disabled' : ''}>${label}</button>`);
  };

  add(1, '«', false, page === 1);
  add(page - 1, '‹', false, page === 1);

  const inicio = Math.max(1, Math.min(page - 2, pages - 4));
  const fim = Math.min(pages, inicio + 4);
  for (let p = inicio; p <= fim; p += 1) add(p, p, p === page);

  add(page + 1, '›', false, page === pages);
  add(pages, '»', false, page === pages);

  el.innerHTML = botoes.join('') + `<span class="page-info">pagina ${page} de ${pages} · ${fmtNum(totalItens)} resultados</span>`;

  $$('#paginacao button').forEach((b) => b.addEventListener('click', () => {
    const p = Number(b.dataset.page);
    if (!p) return;
    if (state.modoTudo) {
      if (p === state.paginaTudo) return;
      state.paginaTudo = p;
      const inicioIdx = (p - 1) * state.limit;
      renderTabela(state.dadosCompletos.slice(inicioIdx, inicioIdx + state.limit));
      renderPaginacao();
      window.scrollTo({ top: $('#painelResultados').offsetTop - 90, behavior: 'smooth' });
    } else if (p !== state.page) {
      state.page = p;
      buscar(false);
      window.scrollTo({ top: $('#painelResultados').offsetTop - 90, behavior: 'smooth' });
    }
  }));
}

/* ----------------------------- MODO COMPLETO ----------------------------- */
function sairModoTudo(rerender = true) {
  if (state.abort) { try { state.abort.abort(); } catch (_) { /* ignore */ } state.abort = null; }
  state.modoTudo = false;
  state.dadosCompletos = [];
  state.paginaTudo = 1;
  $('#badgeModo').hidden = true;
  $('#btnParar').hidden = true;
  if (rerender) esconderProgresso();
}

async function carregarTudo() {
  if (state.ocupado) { toast('Ja existe uma operacao em andamento.', 'err'); return; }

  const filtros = lerFiltros();
  const total = state.total;
  if (!total) { toast('Nenhuma empresa para carregar. Ajuste os filtros.', 'err'); return; }

  if (total > state.limiteTudo) {
    toast(`O resultado tem ${fmtNum(total)} empresas — acima do limite de ${fmtNum(state.limiteTudo)} para exibir na tela. Use BAIXAR TODAS (CSV) para obter o conjunto completo.`, 'err', 7000);
    return;
  }

  state.ocupado = true;
  state.abort = new AbortController();
  state.dadosCompletos = [];
  state.modoTudo = true;
  state.paginaTudo = 1;
  $('#btnParar').hidden = false;
  $('#badgeModo').hidden = false;
  $('#badgeModo').textContent = 'CARREGANDO...';

  const t0 = Date.now();
  try {
    const resp = await fetch(montarUrl('/api/companies/stream', filtros), { headers: cabecalhos(), signal: state.abort.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let resto = '';
    let recebidos = 0;
    let ultimoRender = Date.now();

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      resto += dec.decode(value, { stream: true });
      const partes = resto.split('\n');
      resto = partes.pop();

      for (const linha of partes) {
        if (!linha.trim()) continue;
        let obj;
        try { obj = JSON.parse(linha); } catch (_) { continue; }
        if (obj.__meta) continue;
        state.dadosCompletos.push(obj);
        recebidos += 1;
      }

      const pct = total ? (recebidos / total) * 100 : 0;
      const seg = (Date.now() - t0) / 1000;
      setProgresso(pct, `${fmtNum(recebidos)} / ${fmtNum(total)} empresas`, `${seg > 0 ? Math.round(recebidos / seg) : 0}/s · ${fmtBytes(0)}`);

      if (Date.now() - ultimoRender > 400) {
        ultimoRender = Date.now();
        const idx = 0;
        renderTabela(state.dadosCompletos.slice(idx, idx + state.limit));
      }
    }

    renderTabela(state.dadosCompletos.slice(0, state.limit));
    renderPaginacao();
    $('#badgeModo').textContent = `${fmtNum(state.dadosCompletos.length)} CARREGADAS`;

    const completo = state.dadosCompletos.length >= total;
    setProgresso(100, `${fmtNum(state.dadosCompletos.length)} / ${fmtNum(total)} empresas`, completo ? '✔ completo' : 'incompleto');
    toast(completo
      ? `✔ Todas as ${fmtNum(total)} empresas foram carregadas na tabela.`
      : `Atencao: ${fmtNum(state.dadosCompletos.length)} de ${fmtNum(total)} carregadas.`, completo ? 'ok' : 'err', 6000);
  } catch (e) {
    if (e.name === 'AbortError') toast('Carregamento interrompido.', '');
    else toast(`Falha ao carregar tudo: ${e.message}`, 'err');
  } finally {
    state.ocupado = false;
    state.abort = null;
    $('#btnParar').hidden = true;
  }
}

/* ----------------------------- DOWNLOAD COMPLETO ----------------------------- */
async function baixarTudo(formato, layout) {
  if (state.ocupado) { toast('Ja existe uma operacao em andamento.', 'err'); return; }

  const filtros = lerFiltros();
  const total = state.total;
  if (!total) { toast('Nenhuma empresa para exportar. Ajuste os filtros.', 'err'); return; }

  const gz = formato.endsWith('.gz');
  const ext = gz ? `${formato}` : formato;
  const nomeArquivo = `empresas-${(filtros.uf || 'br').toLowerCase()}${filtros.municipio ? '-' + filtros.municipio.toLowerCase().replace(/\W+/g, '-') : ''}${layout === 'socio' ? '-socios' : ''}-${new Date().toISOString().slice(0, 10)}.${ext}`;

  state.ocupado = true;
  state.abort = new AbortController();
  $('#btnParar').hidden = false;

  const t0 = Date.now();
  let writable = null;
  let chunks = [];

  try {
    const resp = await fetch(montarUrl('/api/export', { ...filtros, formato, layout, max: 0 }), { headers: cabecalhos(), signal: state.abort.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const totalRows = Number(resp.headers.get('X-Total-Rows') || total);

    // Escrita direta em disco (Chrome/Edge) evita carregar tudo na memoria
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({ suggestedName: nomeArquivo });
        writable = await handle.createWritable();
      } catch (err) {
        if (err.name === 'AbortError') { toast('Download cancelado.', ''); return; }
        writable = null;
      }
    }

    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let resto = '';
    let bytes = 0;
    let linhas = 0;
    let ultimo = Date.now();

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (writable) await writable.write(value);
      else chunks.push(value);

      if (!gz) {
        resto += dec.decode(value, { stream: true });
        const partes = resto.split('\n');
        resto = partes.pop();
        linhas += partes.length;
      }

      if (Date.now() - ultimo > 250) {
        ultimo = Date.now();
        const seg = Math.max((Date.now() - t0) / 1000, 0.001);
        const pct = !gz && totalRows ? (linhas / totalRows) * 100 : Math.min((bytes / 40000000) * 100, 99);
        setProgresso(pct, `${fmtBytes(bytes)} recebidos${!gz ? ` · ${fmtNum(linhas)} linhas` : ''}`, `${fmtBytes(bytes / seg)}/s`);
      }
    }

    if (writable) await writable.close();
    else {
      const blob = new Blob(chunks, { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = nomeArquivo;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    }

    // Validacao de completude
    const dados = layout === 'empresa' && !gz ? Math.max(linhas - 1, 0) : null;
    const completo = dados === null ? null : dados === totalRows;

    setProgresso(100, `${fmtBytes(bytes)} · ${nomeArquivo}`, completo === false ? 'verifique o total' : '✔ concluido');
    if (completo === true) {
      toast(`✔ Arquivo completo: ${fmtNum(dados)} de ${fmtNum(totalRows)} empresas exportadas.`, 'ok', 7000);
    } else if (completo === false) {
      toast(`Atencao: o arquivo tem ${fmtNum(dados)} linhas e o banco informou ${fmtNum(totalRows)}. Rode a auditoria de completude.`, 'err', 9000);
    } else {
      toast(`Download concluido: ${nomeArquivo} (${fmtBytes(bytes)}).`, 'ok', 6000);
    }
  } catch (e) {
    if (e.name === 'AbortError') toast('Download interrompido.', '');
    else toast(`Falha no download: ${e.message}`, 'err');
    if (writable) { try { await writable.abort(); } catch (_) { /* ignore */ } }
  } finally {
    state.ocupado = false;
    state.abort = null;
    $('#btnParar').hidden = true;
  }
}

function pararOperacao() {
  if (state.abort) { state.abort.abort(); toast('Parando...', ''); }
}

/* ----------------------------- DETALHE ----------------------------- */
async function abrirDetalhe(cnpj) {
  loader(true);
  try {
    const { data: e } = await api(`/api/companies/${cnpj}`);
    const sit = (e.situacao || 'OUTRA').toUpperCase();
    const classe = ['ATIVA', 'BAIXADA', 'SUSPENSA', 'INAPTA', 'NULA'].includes(sit) ? sit : 'OUTRA';
    const item = (k, v) => `<div class="det-item"><div class="k">${k}</div><div class="v">${esc(v || '—')}</div></div>`;

    $('#detalheConteudo').innerHTML = `
      <div class="det-header">
        <div class="det-title">
          <h3>${esc(e.razaoSocial || '(razao social nao importada)')}</h3>
          ${e.nomeFantasia ? `<div class="fantasia">${esc(e.nomeFantasia)}</div>` : ''}
          <div class="det-cnpj">${esc(e.cnpjFormatado || e.cnpj)}</div>
        </div>
        <div><span class="situacao s-${classe}">${esc(sit)}</span></div>
      </div>

      <div class="det-grid">
        ${item('Tipo / Porte', (e.tipos || []).join(' · '))}
        ${item('Natureza juridica', e.naturezaJuridica)}
        ${item('Matriz / Filial', e.matrizFilial)}
        ${item('Data de abertura', fmtData(e.dataAbertura))}
        ${item('Situacao desde', fmtData(e.dataSituacao))}
        ${item('Motivo da situacao', e.motivoSituacao)}
        ${item('Capital social', fmtMoeda(e.capitalSocial))}
        ${item('Simples Nacional', e.simples?.opcaoSimples ? 'Sim' : 'Nao')}
        ${item('MEI', e.simples?.opcaoMei ? 'Sim' : 'Nao')}
        ${item('CNAE principal', `${e.cnaePrincipalCodigo || ''} ${e.cnaePrincipal || ''}`)}
        ${item('Telefone', e.contato?.telefone1 ? `${e.contato.ddd1 || ''} ${e.contato.telefone1}` : '')}
        ${item('E-mail', e.contato?.email)}
      </div>

      <div class="det-section">
        <h4><span class="dot-gold"></span> Endereco</h4>
        <div class="det-item">
          <div class="v">
            ${esc([e.endereco?.tipoLogradouro, e.endereco?.logradouro, e.endereco?.numero].filter(Boolean).join(' '))}
            ${e.endereco?.complemento ? ` — ${esc(e.endereco.complemento)}` : ''}<br />
            ${esc(e.endereco?.bairro || '')} · ${esc(e.endereco?.municipio || '')}/${esc(e.endereco?.uf || '')} · CEP ${esc(e.endereco?.cep || '')}
          </div>
        </div>
      </div>

      <div class="det-section">
        <h4><span class="dot-gold"></span> Quadro societario (${(e.socios || []).length})</h4>
        ${(e.socios || []).length === 0
          ? '<p style="color:var(--muted)">Nenhum socio registrado para esta empresa.</p>'
          : (e.socios || []).map((s) => `
            <div class="socio-card">
              <div>
                <div class="nome">${esc(s.nome)}</div>
                <div class="meta">${esc(s.qualificacao || '')} ${s.faixaEtaria ? `· faixa ${esc(s.faixaEtaria)}` : ''}</div>
              </div>
              <div style="text-align:right">
                <div class="doc">${esc(s.documento || '')}</div>
                <div class="meta">desde ${fmtData(s.dataEntrada)}</div>
              </div>
            </div>`).join('')}
      </div>

      ${(e.cnaesSecundarios || []).length ? `
      <div class="det-section">
        <h4><span class="dot-gold"></span> CNAEs secundarios</h4>
        ${e.cnaesSecundarios.map((c) => `<div class="det-item" style="margin-bottom:8px"><div class="v">${esc(c.codigo)} — ${esc(c.descricao)}</div></div>`).join('')}
      </div>` : ''}
    `;

    $('#modalDetalhe').classList.add('open');
  } catch (err) {
    toast(`Nao foi possivel carregar o detalhe: ${err.message}`, 'err');
  } finally {
    loader(false);
  }
}

/* ----------------------------- MUNICIPIOS ----------------------------- */
let acTimer = null;

function renderAc(itens) {
  const ul = $('#acMunicipios');
  state.municipiosCache = itens;
  state.acIndex = -1;
  if (!itens.length) { ul.classList.remove('open'); return; }
  ul.innerHTML = itens.map((m, i) => `<li data-i="${i}" data-nome="${esc(m.nome)}">${esc(m.nome)}<span class="ac-uf">${m.total !== undefined ? `${fmtNum(m.total)} · ` : ''}${esc(m.uf || '')}</span></li>`).join('');
  ul.classList.add('open');
  ul.querySelectorAll('li').forEach((li) => li.addEventListener('click', () => {
    $('#fMunicipio').value = li.dataset.nome;
    ul.classList.remove('open');
    buscar(true);
  }));
}

async function carregarMunicipios(termo) {
  try {
    const { data } = await api('/api/municipios', { uf: $('#fUf').value, q: termo, limit: 60 });
    renderAc(data);
  } catch (_) {
    renderAc([]);
  }
}

/* ----------------------------- CONFIG ----------------------------- */
function abrirConfig() {
  $('#cfgApiBase').value = state.apiBase;
  $('#cfgApiKey').value = state.apiKey;
  $('#cfgAdminToken').value = state.adminToken;
  $('#cfgStatus').textContent = '';
  $('#modalConfig').classList.add('open');
}

async function testarConexao() {
  const el = $('#cfgStatus');
  el.className = 'cfg-status';
  el.textContent = 'Testando...';
  const baseAntiga = state.apiBase;
  const keyAntiga = state.apiKey;
  state.apiBase = $('#cfgApiBase').value.trim();
  state.apiKey = $('#cfgApiKey').value.trim();
  try {
    const r = await api('/health');
    el.classList.add('ok');
    el.textContent = `OK · banco: ${r.database} · uptime ${r.uptime}s`;
  } catch (e) {
    el.classList.add('err');
    el.textContent = `Falhou: ${e.message}`;
  } finally {
    state.apiBase = baseAntiga;
    state.apiKey = keyAntiga;
  }
}

/* ----------------------------- ADMIN / IMPORTACAO ----------------------------- */
function adminHeaders() {
  const h = cabecalhos();
  if (state.adminToken) h['x-admin-token'] = state.adminToken;
  return h;
}

async function apiAdmin(caminho, opcoes = {}) {
  const resp = await fetch(montarUrl(caminho, opcoes.params), {
    method: opcoes.method || 'GET',
    headers: { ...adminHeaders(), ...(opcoes.body ? { 'Content-Type': 'application/json' } : {}) },
    body: opcoes.body ? JSON.stringify(opcoes.body) : undefined,
  });
  let json = null;
  try { json = await resp.json(); } catch (_) { /* ignore */ }
  if (!resp.ok) {
    const err = new Error((json && (json.message || json.error)) || `HTTP ${resp.status}`);
    err.code = json && json.error;
    err.status = resp.status;
    throw err;
  }
  return json;
}

function abrirAdmin() {
  $('#modalAdmin').classList.add('open');
  carregarDiag();
  carregarHistorico();
}

function fmtDuracao(ms) {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}min ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}min`;
}

async function carregarDiag() {
  const el = $('#adminDiag');
  el.innerHTML = 'carregando...';
  try {
    const { data } = await apiAdmin('/api/admin/diagnostico');
    const ufs = data.base.porUf.slice(0, 12).map((u) => `<span>${esc(u.uf)}: ${fmtNum(u.total)}</span>`).join('');
    el.innerHTML = `
      <div class="linha"><span>Empresas na base</span><b>${fmtNum(data.base.total)}</b></div>
      <div class="linha"><span>Municipios mapeados</span><b>${fmtNum(data.base.municipios)}</b></div>
      <div class="linha"><span>Fonte de dados</span><b style="font-size:0.68rem">${esc(data.servidor.fonteDados)}</b></div>
      <div class="linha"><span>Servidor</span><b>${esc(data.servidor.node)} · ${data.servidor.memoriaMB} MB · ${fmtDuracao(data.servidor.uptime * 1000)}</b></div>
      <div class="linha"><span>Painel protegido</span><b>${data.servidor.adminProtegido ? 'SIM' : 'NAO'}</b></div>
      ${ufs ? `<div class="ufs">${ufs}</div>` : ''}
    `;
  } catch (e) {
    el.innerHTML = `<div class="linha"><span style="color:var(--red)">${esc(e.message)}</span></div>`;
    if (e.code === 'ADMIN_TOKEN_NAO_CONFIGURADO') {
      el.innerHTML += `<div class="linha"><span style="font-size:0.78rem;color:var(--muted)">Defina a variavel <b>ADMIN_TOKEN</b> no Render (Environment) e cole o mesmo valor em ⚙ Configuracoes.</span></div>`;
    }
  }
}

function renderJob(job, ativo) {
  state.jobAtual = job;
  if (!job) return;

  const p = job.progresso || {};
  const st = $('#impStats');
  const cores = { executando: 'st-executando', concluido: 'st-concluido', erro: 'st-erro', cancelado: 'st-cancelado', interrompido: 'st-interrompido' };

  const duracao = job.finalizadoEm ? (new Date(job.finalizadoEm) - new Date(job.iniciadoEm)) : (Date.now() - new Date(job.iniciadoEm));

  st.innerHTML = `
    <div>Status: <span class="status-tag ${cores[job.status] || ''}">${esc(job.status)}</span></div>
    <div>Fase: <b>${esc(job.fase || '—')}</b> ${p.totalArquivos ? `(${p.arquivoNumero || 0}/${p.totalArquivos})` : ''}</div>
    ${p.arquivo ? `<div>Arquivo: <b>${esc(p.arquivo)}</b></div>` : ''}
    <div>Linhas lidas: <b>${fmtNum(p.linhasLidas || 0)}</b> · Registros gravados: <b>${fmtNum(p.gravados || 0)}</b></div>
    <div>Quantidade pedida: <b>${(job.opcoes && job.opcoes.limit) ? fmtNum(job.opcoes.limit) : 'todas'}</b></div>
    <div>Tempo: <b>${fmtDuracao(duracao)}</b>${job.resultado ? ` · ${fmtNum(job.resultado.empresas)} empresas na base` : ''}</div>
    ${job.erro ? `<div style="color:var(--red)">${esc(job.erro)}</div>` : ''}
  `;

  if (job.status === 'executando') {
    $('#impProgressWrap').hidden = false;
    const pct = Math.min(((job.faseNumero || 0) / (job.totalFases || 6)) * 100 + (p.totalArquivos ? (p.arquivoNumero / p.totalArquivos) * 20 : 0), 99);
    $('#impFill').style.width = `${pct}%`;
    $('#impFase').textContent = `${job.fase || 'iniciando'} — ${pct.toFixed(0)}%`;
    $('#impTempo').textContent = fmtDuracao(duracao);
  } else {
    $('#impProgressWrap').hidden = job.status === 'concluido' ? false : $('#impProgressWrap').hidden;
    if (job.status === 'concluido') { $('#impFill').style.width = '100%'; $('#impFase').textContent = 'concluído'; }
  }

  $('#impLog').textContent = (job.log || []).join('\n');
  $('#impLog').scrollTop = $('#impLog').scrollHeight;
  $('#btnCancelarImport').hidden = !ativo;
  $('#btnImportar').disabled = !!ativo;
}

async function carregarHistorico() {
  const el = $('#impHistorico');
  try {
    const r = await apiAdmin('/api/admin/imports');
    if (!r.data.length) { el.innerHTML = '<div class="imp-item"><span class="resumo">Nenhuma importacao registrada ainda.</span></div>'; return; }
    el.innerHTML = r.data.map((j) => `
      <div class="imp-item">
        <div class="topo">
          <span class="uf">${esc(j.uf || 'TODAS')}</span>
          <span class="status-tag st-${esc(j.status)}">${esc(j.status)}</span>
        </div>
        <div class="resumo">
          ${j.resultado ? `${fmtNum(j.resultado.empresas)} empresas · ${fmtNum(j.resultado.socios)} socios · ` : ''}
          ${esc(j.fase || '')}
        </div>
        <div class="quando">${new Date(j.iniciadoEm).toLocaleString('pt-BR')}${j.resultado ? ` · ${fmtDuracao(j.resultado.duracaoMs)}` : ''}</div>
      </div>`).join('');
  } catch (e) {
    el.innerHTML = `<div class="imp-item"><span class="resumo" style="color:var(--red)">${esc(e.message)}</span></div>`;
  }
}

function acompanharJob(id) {
  if (state.jobSse) { state.jobSse.close(); state.jobSse = null; }
  const url = montarUrl(`/api/admin/import/${id}/eventos`, { token: state.adminToken || state.apiKey });
  const es = new EventSource(url);
  state.jobSse = es;

  es.onmessage = (ev) => {
    try {
      const { job, ativo } = JSON.parse(ev.data);
      renderJob(job, ativo);
      if (!ativo) { es.close(); state.jobSse = null; carregarHistorico(); carregarDiag(); }
    } catch (_) { /* ignore */ }
  };
  es.addEventListener('fim', () => { es.close(); state.jobSse = null; carregarHistorico(); carregarDiag(); });
  es.onerror = () => { /* reconecta sozinho */ };
}

async function iniciarImportacao() {
  const uf = $('#impUf').value;
  const limit = Number($('#impLimit').value) || 0;
  const drop = $('#impDrop').checked;

  if (!uf && !limit) {
    const ok = window.confirm('Você escolheu TODO O BRASIL. Isso baixa dezenas de GB e pode levar muitas horas (e estourar o plano do MongoDB). Continuar?');
    if (!ok) return;
  }
  if (drop) {
    const ok = window.confirm('ATENÇÃO: "Apagar a base antes" vai REMOVER todas as empresas já importadas. Continuar?');
    if (!ok) return;
  }

  $('#btnImportar').disabled = true;
  $('#impLog').textContent = 'iniciando...';

  try {
    const r = await apiAdmin('/api/admin/import', {
      method: 'POST',
      body: { uf, limit, drop, skipSocios: $('#impSkipSocios').checked, skipSimples: $('#impSkipSimples').checked, remoto: true },
    });
    toast(r.message, 'ok', 7000);
    $('#btnCancelarImport').hidden = false;
    acompanharJob(r.data.id);
  } catch (e) {
    $('#btnImportar').disabled = false;
    toast(`Nao foi possivel iniciar: ${e.message}`, 'err', 8000);
    if (e.code === 'ADMIN_TOKEN_NAO_CONFIGURADO' || e.code === 'NAO_AUTORIZADO') abrirConfig();
  }
}

async function cancelarImportacao() {
  if (!state.jobAtual) return;
  try {
    await apiAdmin(`/api/admin/import/${state.jobAtual._id}/cancelar`, { method: 'POST' });
    toast('Cancelamento solicitado — aguardando o lote atual terminar.', '', 6000);
  } catch (e) {
    toast(`Falha ao cancelar: ${e.message}`, 'err');
  }
}

/* ----------------------------- INIT ----------------------------- */
async function carregarMeta() {
  try {
    const { data } = await api('/api/meta');
    state.meta = data;

    const selUf = $('#fUf');
    selUf.innerHTML = '<option value="">Todos os estados</option>';
    const comDados = new Set(data.ufsComDados || []);
    (data.ufs || []).forEach((uf) => {
      const opt = document.createElement('option');
      opt.value = uf;
      opt.textContent = comDados.has(uf) ? `${uf} ●` : uf;
      selUf.appendChild(opt);
    });

    const selImp = $('#impUf');
    if (selImp) {
      selImp.innerHTML = '<option value="">— TODO O BRASIL (muito pesado) —</option>' +
        (data.ufs || []).map((uf) => `<option value="${uf}">${uf}${comDados.has(uf) ? ' ● (ja importado)' : ''}</option>`).join('');
    }

    const chips = $('#tipoChips');
    chips.innerHTML = (data.tipos || []).map((t) => `<button class="tipo-chip" data-tipo="${esc(t)}">${esc(t)}</button>`).join('');
    chips.querySelectorAll('.tipo-chip').forEach((c) => c.addEventListener('click', () => {
      const t = c.dataset.tipo;
      if (state.tipos.includes(t)) state.tipos = state.tipos.filter((x) => x !== t);
      else state.tipos.push(t);
      c.classList.toggle('on');
      buscar(true);
    }));

    setStatus('ok', 'Base conectada');
  } catch (e) {
    if (e.message === 'NAO_AUTORIZADO') setStatus('err', 'Chave invalida');
    else setStatus('err', 'API indisponivel');
  }
}

function relogio() { $('#clock').textContent = new Date().toLocaleTimeString('pt-BR'); }

function bindEventos() {
  // Busca explicita: pode disparar a importacao automatica
  $('#btnBuscar').addEventListener('click', () => buscar(true, true));
  $('#btnBuscaRapida').addEventListener('click', () => { $('#fQ').value = $('#buscaRapida').value.trim(); buscar(true, true); });
  $('#buscaRapida').addEventListener('keydown', (e) => { if (e.key === 'Enter') { $('#fQ').value = $('#buscaRapida').value.trim(); buscar(true, true); } });
  $('#fQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') buscar(true, true); });

  $('#btnLimpar').addEventListener('click', () => {
    ['#fMunicipio', '#fCnae', '#fNatureza', '#fAberturaDe', '#fAberturaAte', '#fCapitalMin', '#fCapitalMax', '#fQ'].forEach((s) => { $(s).value = ''; });
    ['#fUf', '#fSituacao', '#fMatrizFilial'].forEach((s) => { $(s).value = ''; });
    $('#fOrdenar').value = 'relevancia';
    ['#fSomenteComSocios', '#fSomenteMei', '#fSomenteSimples'].forEach((s) => { $(s).checked = false; });
    state.tipos = [];
    $$('.tipo-chip').forEach((c) => c.classList.remove('on'));
    $$('.hero-chips .chip').forEach((c) => c.classList.remove('active'));
    buscar(true);
  });

  // Varredura completa
  $('#btnBaixarTudo').addEventListener('click', () => baixarTudo('csv', 'empresa'));
  $('#btnBaixarSocios').addEventListener('click', () => baixarTudo('csv', 'socio'));
  $('#btnBaixarJson').addEventListener('click', () => baixarTudo('json', 'empresa'));
  $('#btnBaixarGz').addEventListener('click', () => baixarTudo('csv.gz', 'empresa'));
  $('#btnCarregarTudo').addEventListener('click', carregarTudo);
  $('#btnParar').addEventListener('click', pararOperacao);

  $('#fLimit').addEventListener('change', (e) => {
    state.limit = Number(e.target.value);
    if (state.modoTudo) {
      state.paginaTudo = 1;
      renderTabela(state.dadosCompletos.slice(0, state.limit));
      renderPaginacao();
    } else {
      buscar(true);
    }
  });
  $('#fOrdenar').addEventListener('change', () => buscar(true));
  $('#fUf').addEventListener('change', () => { $('#fMunicipio').value = ''; buscar(true); });
  $('#fSituacao').addEventListener('change', () => buscar(true));
  ['#fSomenteComSocios', '#fSomenteMei', '#fSomenteSimples', '#fMatrizFilial'].forEach((s) => $(s).addEventListener('change', () => buscar(true)));

  $$('.data-table thead th[data-sort]').forEach((th) => th.addEventListener('click', () => {
    const alvo = th.dataset.sort;
    if ($$('#fOrdenar option').some((o) => o.value === alvo)) $('#fOrdenar').value = alvo;
    buscar(true);
  }));

  const inputMun = $('#fMunicipio');
  inputMun.addEventListener('input', () => {
    clearTimeout(acTimer);
    acTimer = setTimeout(() => carregarMunicipios(inputMun.value.trim()), 260);
  });
  inputMun.addEventListener('focus', () => { if (!state.municipiosCache.length) carregarMunicipios(inputMun.value.trim()); else $('#acMunicipios').classList.add('open'); });
  inputMun.addEventListener('keydown', (e) => {
    const ul = $('#acMunicipios');
    const lis = Array.from(ul.querySelectorAll('li'));
    if (!lis.length || !ul.classList.contains('open')) { if (e.key === 'Enter') buscar(true); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); state.acIndex = Math.min(state.acIndex + 1, lis.length - 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); state.acIndex = Math.max(state.acIndex - 1, 0); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (state.acIndex >= 0) { inputMun.value = lis[state.acIndex].dataset.nome; ul.classList.remove('open'); }
      buscar(true);
      return;
    } else if (e.key === 'Escape') { ul.classList.remove('open'); return; }
    lis.forEach((li, i) => li.classList.toggle('sel', i === state.acIndex));
  });

  document.addEventListener('click', (e) => { if (!e.target.closest('.autocomplete')) $('#acMunicipios').classList.remove('open'); });

  $$('.hero-chips .chip').forEach((chip) => chip.addEventListener('click', () => {
    const val = chip.dataset.quick;
    if (val.startsWith('situacao:')) {
      const sit = val.split(':')[1];
      const jaAtivo = $('#fSituacao').value === sit;
      $('#fSituacao').value = jaAtivo ? '' : sit;
      chip.classList.toggle('active', !jaAtivo);
    } else {
      const idx = state.tipos.indexOf(val);
      if (idx >= 0) state.tipos.splice(idx, 1); else state.tipos.push(val);
      chip.classList.toggle('active');
      $$('.tipo-chip').forEach((c) => c.classList.toggle('on', state.tipos.includes(c.dataset.tipo)));
    }
    buscar(true);
  }));

  $$('[data-close]').forEach((b) => b.addEventListener('click', () => $(`#${b.dataset.close}`).classList.remove('open')));
  $$('.modal-overlay').forEach((ov) => ov.addEventListener('click', (e) => { if (e.target === ov) ov.classList.remove('open'); }));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $$('.modal-overlay').forEach((m) => m.classList.remove('open')); });

  // Painel de preparacao automatica (quantidade + parar)
  $('#btnPrepIniciar').addEventListener('click', () => {
    const v = Math.max(Number($('#prepQtd').value) || 0, 0);
    if (prep.resolver) {
      const resolver = prep.resolver;
      prep.resolver = null;
      prep.rejeitar = null;
      resolver(v);
    }
  });
  $('#btnFecharPrep').addEventListener('click', () => {
    if (prep.resolver) {
      const rejeitar = prep.rejeitar;
      prep.resolver = null;
      prep.rejeitar = null;
      if (rejeitar) rejeitar();
    } else {
      fecharPrep();
    }
  });
  $('#btnPararPrep').addEventListener('click', pararImportacaoPrep);

  // Administracao / importacao
  $('#btnAdmin').addEventListener('click', abrirAdmin);
  $('#btnImportar').addEventListener('click', iniciarImportacao);
  $('#btnCancelarImport').addEventListener('click', cancelarImportacao);
  $('#btnAtualizarDiag').addEventListener('click', () => { carregarDiag(); carregarHistorico(); });

  $('#btnSettings').addEventListener('click', abrirConfig);
  $('#btnTestarConexao').addEventListener('click', testarConexao);
  $('#btnSalvarConfig').addEventListener('click', () => {
    state.apiBase = $('#cfgApiBase').value.trim().replace(/\/+$/, '');
    state.apiKey = $('#cfgApiKey').value.trim();
    state.adminToken = $('#cfgAdminToken').value.trim();
    localStorage.setItem('cnpj_api_base', state.apiBase);
    localStorage.setItem('cnpj_api_key', state.apiKey);
    localStorage.setItem('cnpj_admin_token', state.adminToken);
    $('#modalConfig').classList.remove('open');
    toast('Configuracoes salvas.', 'ok');
    carregarMeta().then(() => buscar(true));
  });

  window.addEventListener('beforeunload', () => { if (state.ocupado) return 'Uma operacao esta em andamento.'; return undefined; });
}

async function init() {
  try {
    relogio();
    setInterval(relogio, 1000);
    bindEventos();
    await carregarMeta();
    await buscar(true);
  } catch (e) {
    console.error('[init]', e);
    setStatus('err', 'Erro ao iniciar');
    toast(`Falha ao iniciar o dashboard: ${e.message}`, 'err', 9000);
  } finally {
    loader(false);
  }
}

/* Rede de seguranca global: qualquer erro inesperado nunca deixa a tela presa */
window.addEventListener('unhandledrejection', (ev) => {
  console.error('[promise]', ev.reason);
  loader(false);
});
window.addEventListener('error', (ev) => {
  console.error('[erro]', ev.error || ev.message);
  loader(false);
});

document.addEventListener('DOMContentLoaded', init);
