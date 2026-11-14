# Self-hosting no macOS (servidor pessoal)

Guia para rodar o NYSE Stock Portfolio Tracker 24h num Mac (por exemplo um Mac Mini em casa),
acessível só por você, sem nuvem paga.

## Modelo de segurança

- O app roda com um **usuário de serviço dedicado**, sem privilégio de administrador e com a
  pasta pessoal fechada (`700`). Outros usuários da máquina não leem o banco nem o `.env`.
- O servidor escuta só em `127.0.0.1`. Nada fica exposto na rede local.
- O acesso de fora é feito por um proxy HTTPS privado. O exemplo usa o
  [`tailscale serve`](https://tailscale.com/kb/1242/tailscale-serve), que só atende aparelhos da
  sua tailnet. **Não use `tailscale funnel`**, que publica na internet.
- Depois de criar a sua conta, feche o cadastro (`ALLOW_REGISTRATION=false`).
- Qualquer processo da própria máquina alcança `127.0.0.1`. Por isso a senha forte e o cadastro
  fechado continuam importantes, mesmo atrás do Tailscale.

## Pré-requisitos

- macOS com Node.js 22 ou mais novo (`brew install node`) e git.
- Ferramentas de linha de comando do Xcode (`xcode-select --install`), caso o `npm ci` precise
  compilar módulos nativos.
- Tailscale instalado e logado (para o acesso remoto).

Nos exemplos abaixo:

| Item | Valor de exemplo |
|---|---|
| Usuário de serviço | `nysetracker` |
| UID livre | `509` (confira com `dscl . -list /Users UniqueID`) |
| Porta interna | `3100` |
| Porta HTTPS do Tailscale | `8444` |

Os comandos com `sudo` pedem a senha de um administrador da máquina.

## 1. Criar o usuário de serviço

Usuário oculto, sem senha e sem shell de login:

```bash
sudo dscl . -create /Users/nysetracker
sudo dscl . -create /Users/nysetracker UniqueID 509
sudo dscl . -create /Users/nysetracker PrimaryGroupID 20
sudo dscl . -create /Users/nysetracker UserShell /usr/bin/false
sudo dscl . -create /Users/nysetracker NFSHomeDirectory /Users/nysetracker
sudo dscl . -create /Users/nysetracker RealName "NYSE Tracker service"
sudo dscl . -create /Users/nysetracker IsHidden 1
sudo dscl . -create /Users/nysetracker Password "*"
sudo mkdir -p /Users/nysetracker/{data,logs}
sudo chown -R nysetracker:staff /Users/nysetracker
sudo chmod 700 /Users/nysetracker
```

## 2. Instalar o app numa versão publicada

Sempre a partir de uma tag (veja as Releases), nunca da `main` em andamento:

```bash
sudo -u nysetracker -H sh -c 'cd /Users/nysetracker && git clone https://github.com/dodopo/NyseStockTracker_app.git app'
sudo -u nysetracker -H sh -c 'cd /Users/nysetracker/app && git checkout --quiet v0.5.0 && npm ci && npm run build && npm test'
```

Os comandos usam `sh -c 'cd ...'` porque o usuário de serviço não consegue entrar na pasta de
quem está digitando (as pastas pessoais são fechadas).

## 3. Configurar o `.env`

Crie o arquivo legível só pelo usuário de serviço:

```bash
sudo -u nysetracker -H sh -c 'umask 077 && cat > /Users/nysetracker/app/.env' <<'EOF'
HOST=127.0.0.1
PORT=3100
DATA_DIR=/Users/nysetracker/data
BACKUP_DIR=/Users/nysetracker/data/backups
BACKUP_RETAIN=30
ALLOW_REGISTRATION=true
TRUST_PROXY=loopback
COOKIE_SECURE=true
SESSION_TTL_DAYS=7
EOF
```

`ALLOW_REGISTRATION=true` é só para criar a primeira conta (passo 6).

## 4. Instalar os serviços (LaunchDaemons)

Os modelos ficam em `deploy/macos/`. O comando abaixo troca os marcadores e instala:

```bash
for f in app backup; do
  sudo sh -c "sed -e 's|__SERVICE_USER__|nysetracker|g' -e 's|__HOME__|/Users/nysetracker|g' /Users/nysetracker/app/deploy/macos/local.nysetracker.$f.plist > /Library/LaunchDaemons/local.nysetracker.$f.plist"
  sudo chown root:wheel /Library/LaunchDaemons/local.nysetracker.$f.plist
  sudo chmod 644 /Library/LaunchDaemons/local.nysetracker.$f.plist
  sudo launchctl bootstrap system /Library/LaunchDaemons/local.nysetracker.$f.plist
done
```

Conferir:

```bash
curl -s http://127.0.0.1:3100/api/auth/me
```

A resposta esperada é `{"authenticated":false,...}`. Os logs ficam em `/Users/nysetracker/logs/`.

## 5. Publicar na tailnet (HTTPS privado)

```bash
tailscale serve --bg --https=8444 http://127.0.0.1:3100
```

```bash
tailscale serve status
```

Acesse de outro aparelho da tailnet: `https://<nome-da-maquina>.<sua-tailnet>.ts.net:8444`.
Em algumas configurações a própria máquina não consegue abrir a própria URL do `serve`; teste
de outro aparelho.

## 6. Criar a sua conta e fechar o cadastro

1. Abra a URL, clique em **CRIAR CONTA** e use uma senha forte (gerenciador de senhas).
2. Cole a sua chave da Finnhub na tela de configuração inicial.
3. Feche o cadastro e reinicie o app:

```bash
sudo -u nysetracker -H sh -c "cd /Users/nysetracker/app && sed -i '' 's/^ALLOW_REGISTRATION=.*/ALLOW_REGISTRATION=false/' .env && chmod 600 .env"
sudo launchctl kickstart -k system/local.nysetracker.app
```

A tela de login deixa de mostrar a aba **CRIAR CONTA**.

## Atualizar para uma nova versão

A atualização é **manual de propósito**: nada chega sozinho do GitHub ao servidor. Leia o
`CHANGELOG.md` da versão nova antes; versões com migração de banco avisam no topo.

### Comando de atualização (recomendado, a partir da v0.5.0)

Instale o comando uma vez, numa cópia **do root**:

```bash
sudo mkdir -p /usr/local/sbin
sudo sh -c 'install -o root -g wheel -m 755 /Users/nysetracker/app/scripts/update.sh /usr/local/sbin/nysetracker-update'
```

Por que uma cópia do root: o arquivo dentro de `app/` pertence ao usuário de serviço. Rodar com
`sudo` um arquivo que o serviço pode alterar daria a um app comprometido um caminho para virar
administrador. Quando uma versão nova mudar o `scripts/update.sh`, revise a mudança e reinstale
a cópia com o mesmo comando.

Para atualizar:

```bash
sudo /usr/local/sbin/nysetracker-update vX.Y.Z
```

O comando, em ordem:

1. confere o formato da versão e se a tag existe. **Se uma tag já publicada tiver sido alterada
   no GitHub, ele para** (proteção contra conta invadida);
2. recusa rodar se houver alterações locais na pasta do app;
3. faz backup do banco;
4. instala a versão nova, compila e roda os testes **com o app antigo ainda no ar**. Se algo
   falhar, reinstala a versão anterior e o app nem é reiniciado;
5. reinicia o serviço e espera `/api/health` responder com a versão nova. Se não responder,
   reinstala a anterior, reinicia e avisa.

Configurações opcionais (variáveis de ambiente): `NYSE_SERVICE_USER`, `NYSE_APP_DIR`,
`NYSE_LAUNCHD_LABEL`, `NYSE_PORT` (padrão 3100) e `NYSE_HEALTH_TIMEOUT` (padrão 60 s). Exemplo:

```bash
sudo NYSE_PORT=3100 /usr/local/sbin/nysetracker-update vX.Y.Z
```

### Primeira atualização vindo da v0.4.x

A v0.4.x ainda não tem o comando. Instale-o direto da tag `v0.5.0`, sem mexer no app:

```bash
sudo -u nysetracker -H sh -c 'cd /Users/nysetracker/app && git fetch --tags --quiet && git show v0.5.0:scripts/update.sh' > /tmp/nysetracker-update
sudo mkdir -p /usr/local/sbin
sudo install -o root -g wheel -m 755 /tmp/nysetracker-update /usr/local/sbin/nysetracker-update
rm /tmp/nysetracker-update
sudo /usr/local/sbin/nysetracker-update v0.5.0
```

Depois, uma única vez, aplique as permissões fechadas da v0.5.0 (os modelos de serviço passaram a
usar `Umask 077`):

```bash
for f in app backup; do
  sudo launchctl bootout system/local.nysetracker.$f
  sudo sh -c "sed -e 's|__SERVICE_USER__|nysetracker|g' -e 's|__HOME__|/Users/nysetracker|g' /Users/nysetracker/app/deploy/macos/local.nysetracker.$f.plist > /Library/LaunchDaemons/local.nysetracker.$f.plist"
  sudo chown root:wheel /Library/LaunchDaemons/local.nysetracker.$f.plist
  sudo chmod 644 /Library/LaunchDaemons/local.nysetracker.$f.plist
  sudo launchctl bootstrap system /Library/LaunchDaemons/local.nysetracker.$f.plist
done
sudo -u nysetracker -H sh -c 'chmod -R go-rwx /Users/nysetracker/data /Users/nysetracker/logs /Users/nysetracker/app/.env'
```

### Atualização manual (sem o comando)

```bash
sudo -u nysetracker -H sh -c 'cd /Users/nysetracker/app && npm run backup'
sudo -u nysetracker -H sh -c 'cd /Users/nysetracker/app && git fetch --tags --quiet && git checkout --quiet vX.Y.Z && npm ci && npm run build && npm test'
sudo launchctl kickstart -k system/local.nysetracker.app
```

## Voltar para a versão anterior (rollback)

O jeito mais simples é o próprio comando, apontando para a versão anterior:

```bash
sudo /usr/local/sbin/nysetracker-update vA.B.C
```

Voltar da v0.5.x para a v0.4.x **não exige restaurar o banco**: a migração da v0.5.0 só
acrescenta colunas e continua preenchendo as antigas. Para versões que avisarem o contrário no
CHANGELOG, faça o rollback manual com o backup tirado **antes** da atualização:

1. Pare o app:

```bash
sudo launchctl bootout system/local.nysetracker.app
```

2. Volte o código e restaure o backup (troque os nomes pelos seus):

```bash
sudo -u nysetracker -H sh -c 'cd /Users/nysetracker/app && git checkout --quiet vA.B.C && npm ci && npm run build'
sudo -u nysetracker -H sh -c 'cd /Users/nysetracker/data && rm -f portfolio.db-wal portfolio.db-shm && cp backups/portfolio-AAAAMMDD-HHMMSS.db portfolio.db'
```

3. Suba de novo:

```bash
sudo launchctl bootstrap system /Library/LaunchDaemons/local.nysetracker.app.plist
```

## Backups

- `npm run backup` faz uma cópia online (pode rodar com o app ligado), confere a integridade e
  mantém as `BACKUP_RETAIN` mais recentes.
- O LaunchDaemon `local.nysetracker.backup` roda todo dia às 03:45.
- Os backups ficam na mesma máquina. Para sobreviver a uma falha de disco, inclua
  `/Users/nysetracker/data/backups` num backup externo (Time Machine ou outro).

## Desinstalar

```bash
sudo launchctl bootout system/local.nysetracker.app
sudo launchctl bootout system/local.nysetracker.backup
sudo rm /Library/LaunchDaemons/local.nysetracker.app.plist /Library/LaunchDaemons/local.nysetracker.backup.plist
tailscale serve --https=8444 off
```

Os dados continuam em `/Users/nysetracker/data` até você apagá-los.
