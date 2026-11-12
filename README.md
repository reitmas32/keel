# keel

Versionado y deploys a [Dokploy](https://dokploy.com) desde la terminal, condicionados a que el CI de GitHub pase.

- **CLI `keel`**: crea versiones (tags semver) y pide deploys.
- **Servidor keel** (self-hosted, una instancia por organización): API + admin + worker. Encola el deploy, espera a que la GitHub Action avise que el CI pasó y entonces despliega la imagen en Dokploy.

```
keel create-version v1.4.0   →  tag + push  →  GitHub Action: test, build, push ghcr.io/<owner>/<repo>:v1.4.0
keel deploy                  →  POST /api/deploys          (queda en waiting_ci)
GitHub Action (último paso)  →  POST /api/ci-result        (ci_passed / ci_failed)
worker de keel               →  Dokploy: imagen :v1.4.0 + deploy  →  deployed / deploy_failed
```

keel nunca consulta a GitHub: la única señal de que el CI terminó es la llamada de la Action a `/api/ci-result`. Si la Action termina antes de que alguien ejecute `keel deploy`, keel ya tiene el resultado guardado y despliega de inmediato.

Estados de un deploy: `waiting_ci → ci_passed → deploying → deployed`, con salidas `ci_failed`, `deploy_failed` y `expired` (el CI no avisó a tiempo).

## Instalar la CLI

Un solo binario (Rust) para Linux, macOS y Windows, en x86_64 y arm64. Solo necesita git.

```bash
# Linux y macOS (instala en ~/.local/bin; KEEL_INSTALL_DIR para otro lugar)
curl -fsSL https://github.com/reitmas32/keel/releases/latest/download/install.sh | sh
```

```powershell
# Windows (instala en %LOCALAPPDATA%\keel\bin y lo agrega al PATH del usuario)
irm https://github.com/reitmas32/keel/releases/latest/download/install.ps1 | iex
```

Con un gestor de paquetes:

```bash
# Homebrew (macOS y Linux), cuando exista el tap reitmas32/homebrew-tap
brew install reitmas32/tap/keel
```

```powershell
# Scoop (Windows)
scoop install https://github.com/reitmas32/keel/releases/latest/download/keel.json
```

Cada release adjunta la fórmula (`keel.rb`) y el manifiesto de Scoop (`keel.json`) con las sumas de sus binarios. Si el repo tiene el secret `HOMEBREW_TAP_TOKEN`, las releases estables también actualizan `Formula/keel.rb` en `reitmas32/homebrew-tap`.

Los dos scripts comprueban el binario contra `SHA256SUMS` de la release. También puedes bajar `keel-<target>` de la [última release](https://github.com/reitmas32/keel/releases/latest) o compilarlo con `cargo install --path apps/cli`. `keel update` reemplaza el binario por el de la última release, también comprobando su suma.

La CLI de TypeScript (`keel-cli.tgz` por npm) queda retirada; la configuración de `~/.keel` (orgs y organización activa) sigue sirviendo igual.

## Uso de la CLI

```bash
keel login                       # pide la org (github.com:konectus-io) y la URL de su API
keel use                         # elige la organización activa entre las configuradas
keel create-version v1.4.0       # valida y publica el tag (desde cualquier rama)
keel create-version v1.4.0 -d stg  # además pide el deploy de esa misma versión a stg
keel versions                    # versiones del repo: rama, quién la creó y cómo terminó su CI
keel deploy                      # pregunta scope y versión
keel deploy -l -s api-prod       # la versión más alta del repo, esté como esté su CI
keel deploy -r -s api-prod       # la versión más alta cuyo CI pasó (--latest-ready)
keel rollback -s api-prod        # vuelve a la versión que estaba desplegada antes en ese scope
keel rollback -s api-prod --to v1.2.0  # a una versión anterior concreta que ya se desplegó ahí
keel scopes                      # scopes del repo: su servicio en Dokploy y qué versión tiene cada uno
keel deploys                     # deploys del repo: estado, cuándo terminaron y por qué fallaron
keel deploys -s staging -n 50    # solo un scope, hasta 50
keel deploys d3f1                # detalle y línea de tiempo de un deploy (id o sus primeros caracteres)
keel deploys d3f1 --log          # además, el log de build/deploy de Dokploy de ese deploy (redactado)
keel deploy -r -s api-prod --wait  # espera a que termine; sale con 28 si falla
keel status                      # scopes, versión actual, último deploy, CI y estado en Dokploy
keel logs -s api-prod -f         # logs del scope en vivo, redactados
keel context                     # (alias: keel remote) org, repo y Dokploy de esta carpeta
keel update                      # instala la última versión de la CLI publicada en GitHub
keel update --check              # solo avisa si hay una versión nueva
```

Todos los comandos aceptan `--json`. Sin terminal (un script, un agente), los errores salen como JSON con `kind` y un código de salida estable, y lo que normalmente se pregunta hay que pasarlo con opciones (`-s`, `-v`/`-l`/`-r`, `-y`).

### Operar Dokploy directamente

La misma CLI opera Dokploy con tu API key, para lo que no es desplegar una versión: leer logs, env, Compose, dominios y bases, y cambiar infraestructura con planes revisados. Viene de [dokploy-agent](https://github.com/reitmas32/agentic-dokploy): las lecturas nunca muestran secretos y todo cambio es un plan que caduca y se aplica una sola vez con su token.

```bash
keel get services                               # apps, Composes y bases con su estado
keel get logs shop/production/api -f            # logs en vivo, redactados
keel get env production/api                     # claves y largo de cada valor, nunca valores
keel compose diff production/docs --file docs.yaml  # diff saneado contra el remoto
keel plan env-patch production/api --set SENTRY_DSN --unset OLD_FLAG --redeploy
keel apply --plan <id> --approve <token>        # una persona revisó el plan
```

La configuración vive en `~/.keel/dokploy/` (`instances/<org>.env` con `DOKPLOY_URL` y `DOKPLOY_API_KEY`, permisos 600). Si ya usabas dokploy-agent, keel lee `~/.config/dokploy-agent` hasta que corras `keel config migrate`. Sin esa configuración, los comandos de versiones y deploys funcionan igual.

Un servicio de Dokploy que es un scope de keel se despliega solo con keel: `keel plan deploy|redeploy` sobre él se rechaza (`keel_managed`) y un cambio de env no puede tocar su variable del tag. Así ningún deploy se salta el CI ni deja desactualizado `keel scopes` o `keel rollback`.

La referencia completa de comandos está en `keel --help` y `keel <comando> --help`.

`keel deploys` muestra, del más reciente al más antiguo:

```text
  VERSIÓN   SCOPE        ESTADO              PEDIDO      TERMINÓ     DURACIÓN   ID
  v1.5.0    staging      ◌ esperando CI      hoy 15:28   —           14s…       511db4d8
  v1.4.0    staging      ✔ desplegado        hoy 15:27   hoy 15:27   9s         2cf61934
  v1.3.1    production   ✖ falló el deploy   hoy 15:27   hoy 15:27   6s         06e41709
            └ Dokploy respondió 404 en /api/application.one: …
```

Con `--json` devuelve los datos sin formato, para scripts. Necesita un servidor keel v0.3.0 o posterior.

La configuración vive en `~/.keel`:

```
~/.keel/
├── current                          # organización activa (la que eligió keel use)
├── github.com:jalocompany/config.json
└── github.com:konectus-io/config.json   # { "org": "...", "apiUrl": "https://..." }
```

`keel create-version` funciona **desde cualquier rama**: el CI corre sobre el tag y la versión se puede desplegar igual. Se detiene sin crear nada si:

- el `origin` del repo no pertenece a la organización activa,
- la rama local y su remota no apuntan al mismo commit (local adelantada, atrasada o divergente, o la rama nunca se subió),
- el tag ya existe en el remoto (o en local),
- la versión no es semver con prefijo `v` (`v1.4.0`, `v2.0.0-rc.1`),
- con `-d <scope>`, el scope no existe en la app del repo (se revisa antes de crear el tag).

Al publicar el tag, la registra en keel como pendiente, con su rama y quién la creó (`user.name` y `user.email` de git). Si keel no responde o es anterior a v0.4.0, la versión se publica igual y keel la conoce cuando llega el resultado de su CI.

`keel versions` muestra cada versión con su ciclo de CI: `◌ CI en curso` mientras corre, `✔ CI ok`, `✖ CI falló`, `✖ CI cancelado`, o `◷ sin resultado del CI` si no avisó en `KEEL_CI_EXPIRY_MINUTES`. Las que no pasaron muestran el link a su run.

```text
  VERSIÓN   RAMA           CREADA POR   CREADA      CI           DURACIÓN DEL CI
  v1.1.0    main           Bruno        hoy 16:35   ✖ CI falló   12s
            └ https://github.com/konectus-io/app/actions/runs/102
  v1.0.0    hotfix/login   Ana          hoy 16:35   ✔ CI ok      26s
  2 versiones · última lista para desplegar: v1.0.0
```

`keel deploy` usa la misma validación de organización y elige la versión así:

| Opción | Versión | Para qué |
| --- | --- | --- |
| `-v v1.4.0` | esa | lo más seguro: no depende de qué más se haya publicado |
| `-l` | el tag semver más alto del remoto, esté como esté su CI | probar lo último en staging |
| `-r` (`--latest-ready`) | la más alta cuyo CI pasó | producción y rollbacks |

Antes de pedir el deploy dice qué versión eligió, quién la creó y cómo va su CI. Si con `-l` la versión la creó otra persona (otro `user.email`), pregunta antes de desplegarla; sin terminal interactiva solo lo avisa. Para crear y desplegar sin carreras con otros devs, usa `create-version -d`: despliega exactamente la versión que acabas de crear.

`keel scopes` lista los scopes de la app del repo, que son los destinos a los que se despliega:

```text
  SCOPE   DOKPLOY                   TIPO      VERSIÓN ACTUAL   ÚLTIMO DEPLOY
  prod    DEV/production/jalo-web   Compose   v0.1.2           ✔ hoy 15:59 · 1m 02s
  stg     DEV/staging/jalo-web      Compose   v0.1.3           ✖ v0.1.4 falló el CI · hoy 15:11
                                                               └ El CI de v0.1.4 terminó con failure.
  2 scopes · despliega con `keel deploy -s <scope> -v <versión>`
```

La versión actual es la del último deploy exitoso. El nombre en Dokploy (`proyecto/entorno/servicio`) se muestra si keel puede leerlo; si no, aparece el id. Con `--json` devuelve los datos sin formato. Con un servidor anterior a v0.5.0 solo lista los nombres.

`keel rollback -s <scope>` vuelve a desplegar la versión anterior que llegó a `deployed` en ese scope, saltándose las que fallaron, con el mismo commit con el que se desplegó. Con `--to` eliges una versión anterior concreta, que debe haberse desplegado ahí antes. Pide confirmación (o `-y` sin terminal interactiva) y no arranca si hay un deploy en curso en ese scope. Un segundo `rollback` deshace el primero: la versión anterior pasa a ser la que se reemplazó.

### Tokens, locks, promote y más

- `keel login --token keel_pat_…` guarda un token personal (créalo en el admin, en «Tokens de API»). `KEEL_TOKEN` lo reemplaza. El token actúa con el rol de su dueño (ver [Miembros y roles](#miembros-y-roles)). Con `KEEL_API_AUTH=required` en el servidor, la API solo acepta peticiones con token, y cada deploy guarda quién lo pidió.
- `keel lock -s prod -m "incidente"` congela un scope: keel rechaza sus deploys (exit 31) hasta `keel unlock -s prod`.
- `keel promote --from stg --to prod` despliega en `prod` la versión que corre en `stg`.
- `keel deploy … --rollback-on-failure` (también en `promote`) espera el deploy y, si falla, vuelve a la versión anterior.
- `keel changes -s prod [-v v1.4.0]` lista los commits y PRs entre lo desplegado y una versión.
- `keel env diff staging/api production/api` compara los nombres de las variables de dos servicios de Dokploy sin mostrar valores.
- `keel init` escribe el workflow de release y revisa que el repo esté vinculado y tenga sus secrets; `keel init --check` solo audita.
- `keel skills add keel-cli` instala el skill para Claude Code, Codex y Copilot en el repo (`-g` para tu usuario).

## Skills para agentes

El repo también es un marketplace de plugins para Claude Code, Codex y Copilot. El skill `keel-cli` le enseña a un agente a usar esta CLI con seguridad: desplegar y hacer rollback solo con keel, leer estado y logs redactados, y cambiar Dokploy con planes que aprueba una persona.

```bash
claude plugin marketplace add reitmas32/keel
claude plugin install keel-cli@keel
```

Los plugins viven en [`plugins/`](plugins/README.md) y el catálogo en [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json). Para validarlos:

```bash
python3 plugins/scripts/validate.py
python3 -m unittest discover -s plugins/tests
```

## Levantar una instancia del servidor en Dokploy

La API, el admin y el worker corren en **una sola imagen** (`getfoundathyon/keel-api`) y en un solo contenedor: comparten la base SQLite del volumen `/data` (o un Postgres, ver [Usar Postgres](#usar-postgres-en-lugar-de-sqlite)). Levanta una instancia por organización (p.ej. `keel.jalo…` y `keel.konectus…`).

### 1. Crea el servicio Compose

En Dokploy: **Project → Create Service → Compose**. Ponle de nombre `keel` (o `keel-konectus`), y en **General → Provider** elige **Raw** y pega este compose (es el mismo que [`deploy/docker-compose.yml`](deploy/docker-compose.yml)):

```yaml
services:
  keel:
    image: docker.io/getfoundathyon/keel-api:v0.8.0
    restart: unless-stopped
    environment:
      DOKPLOY_URL: ${DOKPLOY_URL:?URL de tu Dokploy, p.ej. https://dokploy.konectus.internal}
      DOKPLOY_API_KEY: ${DOKPLOY_API_KEY:?API key de Dokploy (Settings → Profile → API/CLI)}
      KEEL_ADMIN_PASSWORD: ${KEEL_ADMIN_PASSWORD:?Contraseña del admin, mínimo 12 caracteres}
      KEEL_CI_EXPIRY_MINUTES: ${KEEL_CI_EXPIRY_MINUTES:-60}
      KEEL_DEPLOY_TIMEOUT_MINUTES: ${KEEL_DEPLOY_TIMEOUT_MINUTES:-15}
      # optional: la API acepta llamadas sin token, con el rol KEEL_ANONYMOUS_ROLE. required: siempre pide token.
      KEEL_API_AUTH: ${KEEL_API_AUTH:-optional}
      KEEL_ANONYMOUS_ROLE: ${KEEL_ANONYMOUS_ROLE:-deployer}
      # Base de datos: SQLite en el volumen /data por defecto. Para Postgres (p.ej. varias réplicas de keel),
      # descomenta estas dos líneas y define POSTGRES_DSN en el Environment.
      # DB_ENGINE: postgres
      # POSTGRES_DSN: ${POSTGRES_DSN:?DSN de Postgres, p.ej. postgres://keel:contraseña@postgres:5432/keel}
    volumes:
      - keel-data:/data
    expose:
      - "3000"

volumes:
  keel-data:
```

El archivo del repo trae además, comentado, un servicio `postgres` de ejemplo.

- Usa una versión fija (`:v0.8.0`) en lugar de `:latest`, así un redeploy no cambia de versión sin que lo decidas. Para actualizar keel, cambia la tag y redespliega.
- `keel-data` es un volumen con nombre: la base (apps, scopes, tokens de CI e historial) sobrevive a redeploys y actualizaciones de la imagen.
- `expose` solo abre el puerto 3000 dentro de la red de Docker; el acceso desde fuera lo da el dominio del paso 3. No publiques el puerto con `ports`.

### 2. Define las variables de entorno

En la pestaña **Environment** del servicio pega las variables (Dokploy las escribe en el `.env` del compose):

```env
DOKPLOY_URL=https://dokploy.konectus.internal
DOKPLOY_API_KEY=<api key de Dokploy>
KEEL_ADMIN_PASSWORD=<contraseña larga y aleatoria>
```

| Variable                      | Requerida            | Descripción                                                  |
| ----------------------------- | -------------------- | ------------------------------------------------------------ |
| `DOKPLOY_URL`                 | sí                   | URL de tu Dokploy, p.ej. `https://dokploy.konectus.internal` |
| `DOKPLOY_API_KEY`             | sí                   | API key de Dokploy (Settings → Profile → API/CLI)            |
| `KEEL_ADMIN_PASSWORD`         | sí                   | Contraseña del admin, mínimo 12 caracteres                   |
| `KEEL_CI_EXPIRY_MINUTES`      | no (60)              | Minutos que un deploy espera al CI antes de expirar          |
| `KEEL_DEPLOY_TIMEOUT_MINUTES` | no (15)              | Minutos que Dokploy tiene para terminar un deployment        |
| `KEEL_DB_PATH`                | no (`/data/keel.db`) | Ruta de la base SQLite dentro del contenedor                 |
| `DB_ENGINE`                   | no (`sqlite`)        | `sqlite` o `postgres`                                        |
| `POSTGRES_DSN`                | con `postgres`       | `postgres://usuario:contraseña@host:5432/base`               |
| `KEEL_API_AUTH`               | no (`optional`)      | `required`: toda la API (salvo `/health` y `/ci-result`) pide token |
| `KEEL_ANONYMOUS_ROLE`         | no (`deployer`)      | Rol de las llamadas sin token: `none`, `viewer`, `publisher` o `deployer` |

Si falta una variable requerida, el deploy del compose falla mostrando su descripción. Para generar la contraseña: `openssl rand -base64 24`.

Después pulsa **Deploy**.

### 3. Asigna el dominio

En la pestaña **Domains** → **Add Domain**:

| Campo          | Valor                          |
| -------------- | ------------------------------ |
| Service Name   | `keel`                         |
| Host           | `keel.konectus.com`            |
| Path           | `/`                            |
| Container Port | `3000`                         |
| HTTPS          | activado, con Let's Encrypt    |

Vuelve a pulsar **Deploy** para que Dokploy aplique el dominio. Comprueba que responde:

```bash
curl https://keel.konectus.com/api/health
```

Debe devolver `{"ok":true}`. El admin queda en `https://keel.konectus.com/` (la primera vez entra con `KEEL_ADMIN_PASSWORD`, ver [Miembros y roles](#miembros-y-roles)) y la API en `https://keel.konectus.com/api`, que es la URL que usas en `keel login` y en la variable `KEEL_API_URL` de cada repo.

> La GitHub Action tiene que poder llegar a `https://<dominio>/api/ci-result`. Con runners hospedados por GitHub, el dominio debe ser público (el resto de la API y el admin pueden protegerse aparte); si keel solo es accesible en una red interna, usa runners self-hosted dentro de esa red.

### Usar Postgres en lugar de SQLite

Con `DB_ENGINE=postgres` y `POSTGRES_DSN`, keel guarda todo en Postgres (probado con la 17) y al arrancar crea o migra sus tablas (registradas en `schema_migrations`). Con Postgres puedes correr **varias réplicas** de keel: los cambios de estado de un deploy son atómicos y solo una réplica lo ejecuta en Dokploy. Con SQLite, una sola réplica.

Para pasar una instancia existente de SQLite a Postgres, una sola vez:

1. Detén keel y copia la carpeta de la base fuera del volumen, con sus archivos `-wal` si los hay (p.ej. `docker cp <contenedor>:/data ./keel-data`).
2. Desde un clon de este repo, con `pnpm install` hecho:

   ```bash
   pnpm --filter @keel/server db:sqlite-to-postgres "$PWD/keel-data/keel.db" postgres://keel:contraseña@host:5432/keel
   ```

   Crea las tablas, copia todas en una transacción (si algo falla no escribe nada) e imprime las filas copiadas por tabla. Si Postgres ya tiene datos de keel se niega; `--force` los borra y copia de nuevo.
3. Define `DB_ENGINE=postgres` y `POSTGRES_DSN` en el Environment y redespliega.

### Miembros y roles

Cada persona entra al admin con su email y contraseña, y su rol decide qué puede hacer en el admin y con sus tokens de API. Los roles van de menos a más; cada uno puede todo lo del anterior:

| Rol          | Puede                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------- |
| `viewer`     | ver apps, sus scopes, versiones, deploys y bloqueos                                         |
| `publisher`  | registrar versiones (`keel create-version`)                                                  |
| `deployer`   | desplegar (`keel deploy`, `rollback`, `promote`)                                             |
| `maintainer` | bloquear y desbloquear scopes; en el admin, agregar y desvincular scopes y rotar el token de CI de la app |
| `admin`      | todo: miembros, tokens de todos, crear y eliminar apps, auditoría                            |

En **Miembros**, un admin puede dar **permisos por repo y scope** con patrones `*` (p.ej. repo `konectus-io/*` y patrón de scope `prod*` → `viewer`): suben o bajan el rol donde coinciden, gana el más específico y, empatados, el rol más bajo. A un `admin` nunca se le baja. Un token puede tener un **rol máximo** menor que el de su dueño. Si la API niega algo responde `403` con el rol y la acción. Todo cambio desde la API o el admin queda en **Auditoría**.

Para arrancar:

1. Entra al admin dejando el email vacío y con `KEEL_ADMIN_PASSWORD`: entras como el admin de arranque (`admin@localhost`), que también es dueño de los tokens creados antes de los roles. Esta entrada queda como acceso de emergencia.
2. En **Miembros**, invita a cada persona con su rol y mándale el enlace de invitación (un solo uso, vence en 7 días). Con él pone su contraseña.
3. Cada quien crea su token en **Tokens de API** y ejecuta `keel login --token …`.
4. Cuando todos tengan token, define `KEEL_API_AUTH=required`. Mientras sea `optional`, las llamadas sin token actúan con `KEEL_ANONYMOUS_ROLE` (por defecto `deployer`, como antes de los roles): los roles solo protegen de verdad con `required`.

## Vincular un repo

Vincular un repo es crear una **app** en keel y agregarle sus **scopes**: los destinos de deploy (`prod`, `stg`…), cada uno apuntando a un servicio de Dokploy (un Application o un Compose).

### Desde la CLI (recomendado)

Desde la carpeta del repo, con [`gh`](https://cli.github.com) instalado y con sesión:

```bash
keel init --scope prod=<id-o-url-de-dokploy> --scope stg=<id-o-url> --pr
```

`keel init` hace todo y se puede repetir sin duplicar nada:

1. crea la app en keel (necesita rol `admin`; sin terminal, pasa `-y`);
2. agrega los scopes (en una terminal, sin `--scope`, te deja elegir entre los servicios de Dokploy);
3. guarda el token de CI de la app como secret `DEPLOY_API_TOKEN` del repo con `gh`, por stdin: nunca se imprime (`--secret <NOMBRE>` usa otro secret; en una terminal te pregunta si guardarlo o mostrarlo una vez);
4. define la variable `KEEL_API_URL` con la URL que alcanzan los runners de GitHub: `--ci-api-url <url>`, o la de `keel login --ci-api-url <url>` para toda la org (p. ej. un gateway público delante de un keel interno), o la URL de la API. Si el repo ya la tiene, la respeta: solo `--ci-api-url` la cambia;
5. escribe `.github/workflows/keel-release.yml` y, con `--pr`, abre un PR desde la rama `keel/init`. Si el repo ya tiene un workflow de release que notifica a keel (llama a `/ci-result` o tiene un job `notify-keel`), no lo crea; `--workflow` lo crea igual;
6. revisa todo y avisa si GitHub no puede llegar a tu keel (p. ej. un dominio `.internal` detrás de VPN).

`--rotate-token` cambia el token de CI de una app que ya existe y reemplaza el secret en el mismo paso. Sin `gh`, `keel init` se detiene antes de crear nada: el token solo se muestra una vez y no tendría dónde guardarse. `keel init --check` solo revisa.

Crear la app y rotar su token desde la CLI necesita un servidor de keel v0.8.0 o posterior; con uno anterior, `keel init` solo revisa y la app se crea en el admin.

### Desde el admin

1. Entra al admin (`https://<dominio>/`) como admin.
2. En **Apps → Nueva app**: pega la URL del repo de GitHub. Copia el token de CI que aparece (solo se muestra una vez).
3. En la app, **agrega sus scopes**: el nombre del scope (lo que eliges en `keel deploy -s`, p.ej. `prod`) y la URL del servicio copiada del dashboard de Dokploy (`…/services/application/<id>` o `…/services/compose/<id>`). Para un Compose puedes indicar la variable del tag; si la dejas vacía es `DOCKER_TAG`.
4. En el repo de GitHub:
   - Copia [`templates/github/keel-release.yml`](templates/github/keel-release.yml) a `.github/workflows/` y reemplaza el paso `Test` por tus tests.
   - Variable `KEEL_API_URL` = `https://<dominio>/api`.
   - Secret `DEPLOY_API_TOKEN` = el token de CI de la app.
5. Prepara el servicio de Dokploy de cada scope según su tipo:

   | Tipo        | Requisito                                                                                                       | Qué hace keel al desplegar `v1.4.0`                                              |
   | ----------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
   | Application | Proveedor **Docker** con imagen `<registry>/<owner>/<repo>:<algún tag>`                                          | Cambia la imagen a `…:v1.4.0` y despliega (conserva usuario y token de registry) |
   | Compose     | La imagen usa la variable del tag (`image: ${DOCKER_IMAGE}:${DOCKER_TAG}`) y esa variable está en Environment | Pone `DOCKER_TAG=v1.4.0` en Environment, sin tocar el resto, y redespliega       |

   En un Compose, todos los servicios que usan esa variable se actualizan juntos. Si la variable no está definida en el Environment, keel no despliega y marca el deploy como fallido con el motivo.

## Cambio de nombres en v0.7.0

Hasta v0.6.0 el servidor llamaba **scope** al repo vinculado y **servicio** a cada destino de deploy, al revés que la CLI. Desde v0.7.0 el servidor usa los mismos nombres que la CLI:

- una **app** es un repo de GitHub vinculado a keel, con su token de CI (antes "scope" en el admin);
- un **scope** es un destino de deploy de la app, como `prod` o `stg`, que apunta a un servicio de Dokploy (antes "servicio").

"Servicio" queda solo para lo que vive en Dokploy (el Application o Compose al que apunta un scope). En el admin, la sección **Scopes** ahora es **Apps** (`/scopes` redirige a `/apps`), y los permisos usan "patrón de scope".

La API acepta los nombres anteriores, así que la CLI v0.6.0 y anteriores siguen funcionando:

| Nuevo                                           | Se sigue aceptando                                 |
| ----------------------------------------------- | -------------------------------------------------- |
| `GET /api/repos/{owner}/{repo}/scopes`          | `GET …/services` (misma respuesta)                 |
| `PUT`/`DELETE …/scopes/{alias}/lock`            | `PUT`/`DELETE …/services/{alias}/lock`             |
| `POST /api/deploys` con `scope`                 | con `service` (si mandas los dos, deben coincidir) |
| `GET …/deploys?scope=`                          | `?service=`                                        |

Las respuestas traen los dos nombres: la lista de scopes va en `scopes` y en `services`; cada deploy trae `scope` y `service` (y el detalle `scopeKind` y `serviceKind`); los permisos de `whoami` traen `scope` y `service`. Las entradas de auditoría usan `scope`.

La base se migra sola al arrancar: en SQLite se renombran las tablas y columnas (`scopes` → `apps`, `services` → `scopes`, `service_locks` → `scope_locks`, y las columnas `service_*` → `scope_*`); en Postgres lo hace la migración 3. No se pierde nada: deploys, bloqueos, permisos, auditoría y tokens quedan igual. `db:sqlite-to-postgres` acepta una base SQLite con los nombres de antes o con los nuevos.

## Desarrollo

```bash
pnpm install
pnpm test        # vitest en todos los paquetes; los tests del store del servidor corren en SQLite y en Postgres (PGlite)
pnpm typecheck
pnpm lint
pnpm build

# CLI (Rust)
cargo test
cargo clippy --all-targets -- -D warnings
cargo run -p keel -- --help
```

```
apps/cli        CLI keel (Rust): versiones y deploys vía keel, operación de Dokploy
apps/server     Next.js: API (route handlers), admin y worker (instrumentation.ts), SQLite (node:sqlite) o Postgres (pg)
packages/shared Esquemas de la API y máquina de estados del deploy
deploy/         docker-compose de ejemplo para Dokploy
templates/      Workflow de GitHub para los repos que se despliegan con keel
```

Para el servidor en local, copia `apps/server/.env.example` a `apps/server/.env` y ejecuta `pnpm --filter @keel/server dev`.

Los tests de Postgres usan PGlite (Postgres en WASM, sin Docker). Para correrlos contra un servidor real, define `TEST_POSTGRES_DSN=postgres://…` (cada contexto de test usa su propio schema); así lo hace el CI con `postgres:17`.

### Publicar una versión de keel

Push de un tag `vX.Y.Z` → [`release.yml`](.github/workflows/release.yml) corre lint, typecheck y tests, publica la imagen del servidor en Docker Hub (`<DOCKERHUB_IMAGE>:vX.Y.Z` y `:latest`, linux/amd64), compila la CLI para Linux (musl, x86_64 y arm64), macOS (Intel y Apple Silicon) y Windows (x86_64 y arm64), y adjunta los binarios `keel-<target>`, `SHA256SUMS`, `install.sh` e `install.ps1` al GitHub Release. La versión del binario (`keel --version`) es la del tag.

Configuración del repo (Settings → Secrets and variables → Actions):

| Tipo      | Nombre               | Valor                                                        |
| --------- | -------------------- | ------------------------------------------------------------ |
| Variable  | `DOCKERHUB_IMAGE`    | `getfoundathyon/keel-api`                                    |
| Secret    | `DOCKERHUB_USERNAME` | `getfoundathyon`                                             |
| Secret    | `DOCKERHUB_TOKEN`    | Personal access token de Docker Hub con permiso Read & Write |

El token se crea en Docker Hub → Account settings → Personal access tokens.

## Limitaciones actuales

- Application solo con proveedor Docker; Compose solo si la imagen toma el tag de una variable de su Environment.
- Con `KEEL_API_AUTH=optional` (por defecto), cualquiera que alcance la API puede pedir un deploy con el rol `KEEL_ANONYMOUS_ROLE` (solo se ejecuta si el CI de ese commit pasó). Usa `required` para que los roles apliquen a todos.
- El worker corre dentro del proceso de Next.js. Con SQLite, una sola réplica por instancia; con Postgres pueden ser varias.
- En Windows, las carpetas de `~/.keel` se llaman `github.com_<org>` (`:` no es válido en un nombre de archivo).
