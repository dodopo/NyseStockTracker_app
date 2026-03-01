# NyseStockTracker_app

Aplicação para acompanhamento e análise de posições em ações, com histórico de operações e métricas de performance.

## 🚀 Tecnologias
- React + TypeScript
- Vite
- Node.js

Fucnionalidades dessa versão:

	•	Registro de compras e vendas
	•	Cálculo de preço médio
	•	Histórico de transações
	•	Dashboard de performance


## 📦 Instalação

```bash
git clone https://github.com/dodopo/NyseStockTracker_app.git
cd NyseStockTracker_app
npm install
npm run dev
```

## 🔐 Configuração do ambiente (.env)

Este projeto utiliza a API gratuita da Finnhub para buscar dados de mercado em tempo real.

Por motivos de segurança, as chaves de API **não são versionadas** no repositório.  
Você precisa criar um arquivo `.env` local antes de rodar o app.

### 1️⃣ Criar sua chave gratuita na Finnhub

1. Acesse: https://finnhub.io/
2. Crie uma conta gratuita
3. Gere sua API Key no dashboard
4. Copie a chave

> O plano gratuito possui limites de requisição (rate limit).

---

### 2️⃣ Criar o arquivo `.env`

Na raiz do projeto, crie um arquivo chamado `.env` com o seguinte conteúdo:

```env
# APP_URL: The URL where this applet is hosted.
# AI Studio automatically injects this at runtime with the Cloud Run service URL.
# Used for self-referential links, OAuth callbacks, and API endpoints.
APP_URL=http://localhost:3000

# FINNHUB_KEY: Finnhub Stock API
# Real-Time RESTful APIs and Websocket for Stocks, Currencies, and Crypto.
# Access real-time stock API, institutional-grade fundamental and alternative data to supercharge your investment for FREE.
FINNHUB_KEY="digite aqui o código da chave API gerada no Finnhub"
```

## 📦 Execução

Pronto! Agora seu App está instalado, seu ambiente configurado, só basta executar o bash abaixo no CLI (Terminal) dentro da pasta que você baixou o app.

```bash
npm run dev
```
