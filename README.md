# NyseStockTracker_app

Aplicação web full-stack para acompanhamento e análise de posições em ações da NYSE e criptomoedas, com histórico de operações, cálculo de preço médio e métricas de performance.

## 😎 Visão Geral

O projeto permite:

- registrar compras e vendas de ações e criptomoedas, organizadas em abas que você define
- acompanhar histórico de transações
- calcular preço médio ponderado (PM)
- acompanhar lucro/prejuízo realizado e não realizado
- visualizar o consolidado da carteira
- buscar preços de mercado via API externa (Finnhub)
- reduzir chamadas repetidas à API com cache em memória no backend


## 🚀 Tecnologias

### Frontend
- React
- TypeScript
- Vite (build e preview)
- Tailwind CSS

### Backend
- Node.js + Express (servidor em `server.ts`, executado com `tsx`)
- TypeScript
- Helmet e express-rate-limit (segurança)
- Vitest + Supertest (testes)

### Banco de dados
- SQLite via better-sqlite3 (armazenamento local, migrações versionadas)

### APIs externas
- Finnhub (cotações, busca de ativos e estatísticas)
- Massive, ex-Polygon (histórico para os gráficos)


## Funcionalidades atuais

- Registro de ações na carteira
- Registro de transações de compra e venda
- Cálculo de preço médio
- Histórico de transações
- Dashboard consolidado
- Busca de preços de mercado
- Cache de cotações no backend com TTL configurável
- Contas com senha, sessões com validade e carteira isolada por usuário
- Backup e restauração em JSON
- Quantidades e preços com até 8 casas decimais, calculados sem erro de arredondamento
- Abas definidas por você (Configurações → Abas): criar, renomear, trocar a cor, reordenar e excluir; cada aba tem um tipo de ativo (Ação EUA ou Cripto)
- Criptomoedas: busca por nome ou símbolo, cotação ao vivo, até 8 casas decimais, gráfico 24 h e estatísticas
- Consolidado agrupado por aba, com subtotal; clique numa linha para abrir o ativo na aba dele
- Endereço próprio por tela (`#/aba/3/X%3ABTCUSD`): botão voltar e favoritos funcionam
- Botão para mostrar a senha digitada
- Exclusão da própria conta (Configurações → Zona de perigo)
- Conta: trocar senha (desconecta os outros aparelhos), trocar e-mail, trocar a chave da Finnhub (testada antes de salvar), sair de todos os aparelhos e ver as informações da conta
- Gráfico estilo TradingView por ativo: velas e volume, períodos de 1 dia a 2 anos, legenda com abertura/máxima/mínima/fechamento, tela cheia, **as suas compras e vendas marcadas** e a linha do seu preço médio
- Estatísticas: mínima e máxima de 52 semanas, volume médio, valor de mercado e beta


## 📦 Instalação

```bash
git clone https://github.com/dodopo/NyseStockTracker_app.git
cd NyseStockTracker_app
npm install
npm run dev
```

## 🔐 Configuração do ambiente (.env)

Todas as variáveis são opcionais e têm valor padrão seguro. Para personalizar, copie o modelo:

```bash
cp .env.example .env
```

As principais:

| Variável | Padrão | Para que serve |
|---|---|---|
| `PORT` | `3000` | Porta do app |
| `HOST` | `127.0.0.1` | Interface de rede. `127.0.0.1` aceita só a própria máquina |
| `DATA_DIR` | pasta do projeto | Onde fica o banco `portfolio.db`. Em produção, use uma pasta fora do código |
| `ALLOW_REGISTRATION` | `true` | Mude para `false` depois de criar a sua conta, para fechar novos cadastros |
| `SESSION_TTL_DAYS` | `7` | Dias até a sessão expirar |
| `TRUST_PROXY` | desligado | Use `loopback` atrás de um proxy local (ex.: `tailscale serve`) |

A lista completa está comentada em `.env.example`. Nunca versione o seu `.env`.

## 🔑 Chave da Finnhub

O app usa a API gratuita da [Finnhub](https://finnhub.io/) para cotações. Cada usuário cadastra **a própria chave dentro do app**, na tela de configuração inicial que aparece no primeiro login. Não existe mais chave compartilhada no servidor.

1. Crie uma conta gratuita na Finnhub e copie a API key do Dashboard.
2. Faça login no app e cole a chave na tela "Configuração Inicial".

> O plano gratuito da Finnhub tem limite de requisições por minuto.

## 📈 Chave da Massive (gráficos)

O plano gratuito da Finnhub não entrega histórico de preços, então os gráficos usam a
[Massive](https://massive.com/) (antiga Polygon.io). O plano **Stocks Basic** é gratuito, para uso
pessoal e não profissional, com 2 anos de histórico e 5 consultas por minuto (o servidor guarda as
respostas em cache e respeita esse ritmo).

1. Crie uma conta gratuita na Massive (de preferência com e-mail e senha, sem login social).
2. Copie a chave em Dashboard → Keys.
3. No app: Configurações → Conta → **Chave dos gráficos**. A chave é testada antes de ser salva.

A mesma chave é usada para buscar criptomoedas e para o histórico delas.

## 🔒 Segurança

- Senha obrigatória com no mínimo 12 caracteres, guardada com bcrypt.
- Sessões com validade, token aleatório de 256 bits e apenas o hash do token no banco.
- Limite de tentativas de login e de requisições na API.
- Headers de segurança (Helmet) e Content Security Policy em produção.
- Toda consulta ao banco é parametrizada e filtrada pelo usuário logado.
- Backups não incluem a chave da Finnhub por padrão.

Encontrou uma falha? Abra uma issue sem detalhes sensíveis e peça um canal privado.

## ▶ Execução

### Desenvolvimento

```bash
npm run dev
```

Acesse http://localhost:3000. Para encerrar, pressione `Ctrl + C` no terminal.

### Produção

```bash
npm run build
```

```bash
npm start
```

`npm start` sobe o servidor em modo produção (`NODE_ENV=production`), servindo o front já compilado em `dist/`.

### Servidor pessoal (self-hosting)

Para rodar 24h num Mac em casa, com usuário de serviço dedicado, início automático, backup diário
e acesso privado via Tailscale, siga o guia [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

### Backup do banco

```bash
npm run backup
```

Faz uma cópia online do `portfolio.db` (pode rodar com o app ligado), confere a integridade e
mantém as 30 mais recentes (`BACKUP_DIR`, `BACKUP_RETAIN`).

### Atualizar um servidor pessoal

```bash
sudo /usr/local/sbin/nysetracker-update vX.Y.Z
```

Backup, instalação, testes e reinício com volta automática para a versão anterior se algo
falhar. Instalação do comando e detalhes em [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

### Testes

```bash
npm test
```

Roda a suíte de testes (Vitest + Supertest), sem acessar a internet. O CI do GitHub roda a
mesma suíte, o build e o `npm audit` em Node 22, 24 e 26 a cada pull request.

```bash
npm run lint
```

Verifica os tipos do TypeScript.

## 🗂 Estrutura do backend

| Arquivo | Responsabilidade |
|---|---|
| `server.ts` | Ponto de entrada: lê a configuração, abre o banco e sobe o servidor |
| `server/config.ts` | Variáveis de ambiente com valores padrão seguros |
| `server/db.ts` | Abertura do SQLite e migrações versionadas (`PRAGMA user_version`) |
| `server/validation.ts` | Validações puras de entrada e regras da carteira |
| `server/app.ts` | `createApp()`: rotas da API, autenticação e middlewares |
| `server/candles.ts` | Histórico de velas (Massive) com cache e controle de ritmo |
| `shared/` | Código usado pelo servidor **e** pelo navegador: validação (zod), decimais exatos, cálculo de preço médio e tipos de ativo (`assetTypes.ts`) |
| `server/backup.ts` | Backup online do SQLite com checagem de integridade e retenção |
| `scripts/backup.ts` | Comando `npm run backup` |
| `scripts/update.sh` | Comando de atualização com rollback automático |
| `deploy/macos/` | Modelos de LaunchDaemon (app e backup diário) |

## 🧩 Estrutura do frontend

| Pasta | Responsabilidade |
|---|---|
| `src/App.tsx` | Orquestra login, abas, rotas e cabeçalho |
| `src/features/` | Uma pasta por tela: `auth`, `onboarding`, `settings` (inclui as abas), `actions` (tela de uma aba), `chart`, `consolidated` |
| `src/hooks/` | Estado: `useAuth`, `usePortfolio`, `useHashRoute` |
| `src/api/` | Cliente único da API (sempre confere a resposta) e as chamadas tipadas |
| `src/components/ui.tsx` | Componentes visuais reaproveitáveis (cartão, aba, campo de senha) |

## ⏪ Versões e rollback

Cada versão é publicada como tag e Release no GitHub (veja o `CHANGELOG.md`). Para voltar a uma versão anterior:

```bash
git checkout v0.2.0
```

A partir da v0.3.0 o banco passa por migrações. Antes de atualizar, faça uma cópia do arquivo `portfolio.db`; para voltar a uma versão anterior, restaure também a cópia do banco feita antes da atualização.

## 🙏 Créditos

Gráficos feitos com [TradingView Lightweight Charts™](https://www.tradingview.com/lightweight-charts/)
(Apache-2.0), Copyright © TradingView, Inc. — https://www.tradingview.com/
