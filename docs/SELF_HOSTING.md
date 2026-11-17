# Self-hosting no macOS (servidor pessoal)

Guia para rodar o Dodopo Asset Manager 24h num Mac (por exemplo um Mac Mini em casa),
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
| Usuário de serviço | `dodopoam` |
| UID livre | `510` (confira com `dscl . -list /Users UniqueID`) |
| Porta interna | `3100` |
| Porta HTTPS do Tailscale | `8444` |

Os comandos com `sudo` pedem a senha de um administrador da máquina.

## 1. Criar o usuário de serviço

Usuário oculto, sem senha e sem shell de login:

```bash
sudo dscl . -create /Users/dodopoam
sudo dscl . -create /Users/dodopoam UniqueID 510
sudo dscl . -create /Users/dodopoam PrimaryGroupID 20
sudo dscl . -create /Users/dodopoam UserShell /usr/bin/false
sudo dscl . -create /Users/dodopoam NFSHomeDirectory /Users/dodopoam
sudo dscl . -create /Users/dodopoam RealName "Dodopo Asset Manager service"
sudo dscl . -create /Users/dodopoam IsHidden 1
sudo dscl . -create /Users/dodopoam Password "*"
sudo mkdir -p /Users/dodopoam/{data,logs}
sudo chown -R dodopoam:staff /Users/dodopoam
sudo chmod 700 /Users/dodopoam
```

## 2. Instalar o app numa versão publicada

Sempre a partir de uma tag (veja as Releases), nunca da `main` em andamento:

```bash
sudo -u dodopoam -H sh -c 'cd /Users/dodopoam && git clone https://github.com/dodopo/dodopo-asset-manager.git app'
sudo -u dodopoam -H sh -c 'cd /Users/dodopoam/app && git checkout --quiet v0.12.0 && npm ci && npm run build && npm test'
```

Os comandos usam `sh -c 'cd ...'` porque o usuário de serviço não consegue entrar na pasta de
quem está digitando (as pastas pessoais são fechadas).

## 3. Configurar o `.env`

Crie o arquivo legível só pelo usuário de serviço:

```bash
sudo -u dodopoam -H sh -c 'umask 077 && cat > /Users/dodopoam/app/.env' <<'EOF'
HOST=127.0.0.1
PORT=3100
DATA_DIR=/Users/dodopoam/data
BACKUP_DIR=/Users/dodopoam/data/backups
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
  sudo sh -c "sed -e 's|__SERVICE_USER__|dodopoam|g' -e 's|__HOME__|/Users/dodopoam|g' /Users/dodopoam/app/deploy/macos/local.dodopoam.$f.plist > /Library/LaunchDaemons/local.dodopoam.$f.plist"
  sudo chown root:wheel /Library/LaunchDaemons/local.dodopoam.$f.plist
  sudo chmod 644 /Library/LaunchDaemons/local.dodopoam.$f.plist
  sudo launchctl bootstrap system /Library/LaunchDaemons/local.dodopoam.$f.plist
done
```

Conferir:

```bash
curl -s http://127.0.0.1:3100/api/auth/me
```

A resposta esperada é `{"authenticated":false,...}`. Os logs ficam em `/Users/dodopoam/logs/`.

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
sudo -u dodopoam -H sh -c "cd /Users/dodopoam/app && sed -i '' 's/^ALLOW_REGISTRATION=.*/ALLOW_REGISTRATION=false/' .env && chmod 600 .env"
sudo launchctl kickstart -k system/local.dodopoam.app
```

A tela de login deixa de mostrar a aba **CRIAR CONTA**.

## Atualizar para uma nova versão

A atualização é **manual de propósito**: nada chega sozinho do GitHub ao servidor. Leia o
`CHANGELOG.md` da versão nova antes; versões com migração de banco avisam no topo.

### Comando de atualização (recomendado)

Instale o comando uma vez, numa cópia **do root**:

```bash
sudo mkdir -p /usr/local/sbin
sudo sh -c 'install -o root -g wheel -m 755 /Users/dodopoam/app/scripts/update.sh /usr/local/sbin/dodopoam-update'
```

Por que uma cópia do root: o arquivo dentro de `app/` pertence ao usuário de serviço. Rodar com
`sudo` um arquivo que o serviço pode alterar daria a um app comprometido um caminho para virar
administrador. Quando uma versão nova mudar o `scripts/update.sh`, revise a mudança e reinstale
a cópia com o mesmo comando.

Para atualizar:

```bash
sudo /usr/local/sbin/dodopoam-update vX.Y.Z
```

O comando, em ordem:

1. confere o formato da versão e se a tag existe. **Se uma tag já publicada tiver sido alterada
   no GitHub, ele para** (proteção contra conta invadida);
2. recusa rodar se houver alterações locais na pasta do app;
3. faz backup do banco;
4. instala a versão nova, compila e roda os testes **com o app antigo ainda no ar**. Se algo
   falhar, reinstala a versão anterior e o app nem é reiniciado;
5. faz **outro backup logo antes de reiniciar**, reinicia o serviço e espera `/api/health`
   responder com a versão nova. Se não responder: para o serviço, reinstala a anterior e **devolve
   o banco desse último backup** (a versão nova pode ter migrado o banco ao subir). A cópia do
   backup é feita e conferida antes de mexer no banco; o banco da tentativa fica guardado como
   `portfolio.db.falhou-<data>`, nunca é apagado. Se não der para restaurar e o banco tiver mudado,
   o serviço **fica parado de propósito** (a versão anterior não roda direito num banco migrado) e
   a mensagem diz o que fazer.

Desde a v0.13.0 o comando também **confere se ele mesmo é o publicado na versão pedida** e, se
não for, para antes de qualquer coisa. Para instalar ou trocar o comando (e antes de atualizar
para uma versão cujo `scripts/update.sh` mudou):

```bash
sudo sh -c 'umask 022 && sudo -u dodopoam -H sh -c "cd /Users/dodopoam/app && git fetch --tags --quiet && git show vX.Y.Z:scripts/update.sh" > /usr/local/sbin/dodopoam-update.novo && chmod 755 /usr/local/sbin/dodopoam-update.novo && mv /usr/local/sbin/dodopoam-update.novo /usr/local/sbin/dodopoam-update'
```

Configurações opcionais (variáveis de ambiente): `DAM_SERVICE_USER`, `DAM_APP_DIR`,
`DAM_LAUNCHD_LABEL`, `DAM_PORT` (padrão 3100) e `DAM_HEALTH_TIMEOUT` (padrão 60 s). Os nomes antigos `NYSE_*` continuam aceitos. Exemplo:

```bash
sudo DAM_PORT=3100 /usr/local/sbin/dodopoam-update vX.Y.Z
```

### Migrar de uma instalação antiga (usuário `nysetracker`, até a v0.11.x)

Até a v0.11.x o app se chamava NYSE Stock Portfolio Tracker e rodava como o usuário
`nysetracker`, com os serviços `local.nysetracker.*` e o comando `nysetracker-update`. A v0.12.0
troca tudo para `dodopoam`. A migração é feita **uma vez** pelo script
`scripts/migrate-from-nysetracker.sh`, que **não apaga nada** da instalação antiga:

1. confere o ambiente (usuário antigo no ar, UID livre, porta, tag publicada);
2. cria o usuário `dodopoam`, instala a versão nova e roda os testes **com o app antigo no ar**;
3. faz backup do banco antigo, para o app antigo e **copia** dados, backups e `.env` para o usuário
   novo (conferindo a integridade do banco copiado);
4. guarda os serviços e o comando antigos em `/usr/local/share/dodopoam-migration/` (para eles não
   voltarem sozinhos num reboot) e liga os serviços novos na mesma porta;
5. espera `/api/health` responder com a versão nova e instala o `dodopoam-update`.

Se qualquer passo depois de parar o app antigo falhar, o script **desfaz sozinho** e religa a
instalação antiga. A mesma porta interna (3100) é usada, então o `tailscale serve` não muda.

O script roda como root, então ele é gravado direto numa pasta que só o root altera (sem passar
por `/tmp`, onde outro usuário da máquina poderia trocá-lo). Ele sai da tag pela cópia antiga do
app (o GitHub redireciona o endereço antigo do repositório):

```bash
sudo sh -c 'umask 077 && sudo -u nysetracker -H sh -c "cd /Users/nysetracker/app && git fetch --tags --quiet && git show v0.12.0:scripts/migrate-from-nysetracker.sh" > /usr/local/sbin/dodopoam-migrate'
```

Confira a impressão digital com a publicada nas notas da Release v0.12.0 no GitHub. Se não for
igual, **pare** e apague o arquivo:

```bash
sudo shasum -a 256 /usr/local/sbin/dodopoam-migrate
```

Rode primeiro a simulação:

```bash
sudo sh /usr/local/sbin/dodopoam-migrate --dry-run v0.12.0
```

A simulação só lê e mostra o que seria feito. Estando tudo certo, rode de verdade:

```bash
sudo sh /usr/local/sbin/dodopoam-migrate v0.12.0
```

Se a conexão SSH cair no meio, o script continua sozinho até o fim (ou até desfazer). O registro
fica em `/usr/local/share/dodopoam-migration/migrate.log`:

```bash
sudo tail -n 20 /usr/local/share/dodopoam-migration/migrate.log
```

Para voltar para a instalação antiga depois (o que for salvo na versão nova depois da migração
fica só no usuário novo):

```bash
sudo sh /usr/local/sbin/dodopoam-migrate --rollback
```

O usuário `nysetracker` e os dados dele ficam intactos até você decidir apagá-los, depois de
alguns dias com a versão nova funcionando.

### Atualização manual (sem o comando)

```bash
sudo -u dodopoam -H sh -c 'cd /Users/dodopoam/app && npm run backup'
sudo -u dodopoam -H sh -c 'cd /Users/dodopoam/app && git fetch --tags --quiet && git checkout --quiet vX.Y.Z && npm ci && npm run build && npm test'
sudo launchctl kickstart -k system/local.dodopoam.app
```

## Voltar para a versão anterior (rollback)

O jeito mais simples é o próprio comando, apontando para a versão anterior (se o
`scripts/update.sh` daquela versão for diferente, o comando recusa; nesse caso use o rollback
manual abaixo):

```bash
sudo /usr/local/sbin/dodopoam-update vA.B.C
```

Voltar da v0.5.x para a v0.4.x **não exige restaurar o banco**: a migração da v0.5.0 só
acrescenta colunas e continua preenchendo as antigas. **A v0.13.0 muda a estrutura do banco
(carteiras): voltar dela para a v0.12.x exige restaurar o backup tirado antes da atualização**
(o que for salvo na v0.13.0 depois disso se perde). A v0.14.0 só acrescenta colunas (classificação,
moeda e PTAX): a v0.13.x ainda funciona sobre o banco migrado, mas o que for gravado nela fica com os
valores padrão (moeda do ativo, PTAX buscada de novo quando a v0.14.0 voltar); o caminho mais seguro
continua sendo restaurar o backup. Para essas versões, faça o rollback manual com
o backup tirado **antes** da atualização:

1. Pare o app:

```bash
sudo launchctl bootout system/local.dodopoam.app
```

2. Volte o código e restaure o backup (troque os nomes pelos seus):

```bash
sudo -u dodopoam -H sh -c 'cd /Users/dodopoam/app && git checkout --quiet vA.B.C && npm ci && npm run build'
sudo -u dodopoam -H sh -c 'cd /Users/dodopoam/data && rm -f portfolio.db-wal portfolio.db-shm && cp backups/portfolio-AAAAMMDD-HHMMSS.db portfolio.db'
```

3. Suba de novo:

```bash
sudo launchctl bootstrap system /Library/LaunchDaemons/local.dodopoam.app.plist
```

## Backups

- `npm run backup` faz uma cópia online (pode rodar com o app ligado), confere a integridade e
  mantém as `BACKUP_RETAIN` mais recentes.
- O LaunchDaemon `local.dodopoam.backup` roda todo dia às 03:45.
- Os backups ficam na mesma máquina. Para sobreviver a uma falha de disco, inclua
  `/Users/dodopoam/data/backups` num backup externo (Time Machine ou outro).

## Desinstalar

```bash
sudo launchctl bootout system/local.dodopoam.app
sudo launchctl bootout system/local.dodopoam.backup
sudo rm /Library/LaunchDaemons/local.dodopoam.app.plist /Library/LaunchDaemons/local.dodopoam.backup.plist
tailscale serve --https=8444 off
```

Os dados continuam em `/Users/dodopoam/data` até você apagá-los.
