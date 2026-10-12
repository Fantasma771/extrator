'use strict';

const { mongoose } = require('../db');

const SocioSchema = new mongoose.Schema(
  {
    nome: { type: String, index: true },
    nomeNormalizado: { type: String },
    documento: String, // CPF/CNPJ mascarado ou numero
    tipoDocumento: String, // CPF | CNPJ | ESTRANGEIRO
    qualificacaoCodigo: String,
    qualificacao: String,
    dataEntrada: Date,
    faixaEtaria: String,
    representanteLegal: String,
    nomeRepresentante: String,
    qualificacaoRepresentante: String,
    pais: String,
  },
  { _id: false }
);

const CompanySchema = new mongoose.Schema(
  {
    cnpj: { type: String, required: true, unique: true, index: true }, // 14 digitos
    cnpjFormatado: String,
    cnpjBasico: { type: String, index: true },
    cnpjOrdem: String,
    cnpjDv: String,

    razaoSocial: { type: String, index: true },
    razaoSocialNormalizada: { type: String, index: true },
    nomeFantasia: String,
    nomeFantasiaNormalizado: String,

    matrizFilial: { type: String, index: true }, // MATRIZ | FILIAL

    situacao: { type: String, index: true }, // ATIVA | BAIXADA | SUSPENSA | INAPTA | NULA
    situacaoCodigo: String,
    motivoSituacao: String,
    dataSituacao: Date,
    situacaoEspecial: String,
    dataSituacaoEspecial: Date,

    dataAbertura: { type: Date, index: true },

    cnaePrincipalCodigo: { type: String, index: true },
    cnaePrincipal: String,
    cnaesSecundarios: [{ codigo: String, descricao: String, _id: false }],

    naturezaJuridicaCodigo: String,
    naturezaJuridica: String,
    qualificacaoResponsavel: String,

    capitalSocial: { type: Number, index: true, default: 0 },
    porteCodigo: String,
    porte: String, // MEI | ME | EPP | DEMAIS

    // Etiquetas agregadas: ex ["ME","LTDA","SIMPLES"]
    tipos: { type: [String], index: true },

    simples: {
      opcaoSimples: Boolean,
      dataOpcaoSimples: Date,
      dataExclusaoSimples: Date,
      opcaoMei: Boolean,
      dataOpcaoMei: Date,
      dataExclusaoMei: Date,
    },

    endereco: {
      tipoLogradouro: String,
      logradouro: String,
      numero: String,
      complemento: String,
      bairro: String,
      cep: String,
      uf: { type: String, index: true },
      municipio: { type: String, index: true },
      codigoMunicipio: String,
      pais: String,
      nomeCidadeExterior: String,
    },

    contato: {
      ddd1: String,
      telefone1: String,
      ddd2: String,
      telefone2: String,
      fax: String,
      email: String,
    },

    socios: [SocioSchema],
    sociosCount: { type: Number, default: 0, index: true },
    sociosNomes: { type: [String] },

    origem: { type: String, default: 'receita-federal' },
    atualizadoEm: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
    collection: 'companies',
  }
);

// Indices compostos que sustentam os filtros do dashboard
CompanySchema.index({ 'endereco.uf': 1, 'endereco.municipio': 1, situacao: 1 });
CompanySchema.index({ 'endereco.uf': 1, tipos: 1, situacao: 1 });
CompanySchema.index({ 'endereco.uf': 1, 'endereco.municipio': 1, tipos: 1 });
CompanySchema.index({ 'endereco.uf': 1, dataAbertura: -1 });
CompanySchema.index({ razaoSocialNormalizada: 1, 'endereco.uf': 1 });
CompanySchema.index({ sociosNomes: 1 });

CompanySchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    delete ret._id;
    delete ret.id;
    return ret;
  },
});

module.exports = mongoose.models.Company || mongoose.model('Company', CompanySchema);
