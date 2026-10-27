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

Requiere Node 22.5 o superior y git.

```bash
npm i -g https://github.com/reitmas32/keel/releases/latest/download/keel-cli.tgz
```

## Uso de la CLI

```bash
keel login                       # pide la org (github.com:konectus-io) y la URL de su API
keel use                         # elige la organización activa entre las configuradas
keel create-version v1.4.0       # valida y publica el tag
keel deploy                      # pregunta servicio y versión
keel deploy -l -s api-prod       # despliega la última versión en api-prod
```

La configuración vive en `~/.keel`:

```
~/.keel/
├── current                          # organización activa (la que eligió keel use)
├── github.com:jalocompany/config.json
└── github.com:konectus-io/config.json   # { "org": "...", "apiUrl": "https://..." }
```

`keel create-version` se detiene sin crear nada si:

- el `origin` del repo no pertenece a la organización activa,
- la rama local y su remota no apuntan al mismo commit (local adelantada, atrasada o divergente),
- el tag ya existe en el remoto (o en local),
- la versión no es semver con prefijo `v` (`v1.4.0`, `v2.0.0-rc.1`).

`keel deploy` usa la misma validación de organización. `-l` toma el tag semver más alto del remoto; `-s` y `-v` evitan las preguntas.

## Levantar una instancia del servidor en Dokploy

La API, el admin y el worker corren en **una sola imagen** (`getfoundathyon/keel-api`) y en un solo contenedor: comparten la base SQLite del volumen `/data`. Levanta una instancia por organización (p.ej. `keel.jalo…` y `keel.konectus…`).

### 1. Crea el servicio Compose

En Dokploy: **Project → Create Service → Compose**. Ponle de nombre `keel` (o `keel-konectus`), y en **General → Provider** elige **Raw** y pega este compose (es el mismo que [`deploy/docker-compose.yml`](deploy/docker-compose.yml)):

```yaml
services:
  keel:
    image: docker.io/getfoundathyon/keel-api:v0.2.0
    restart: unless-stopped
    environment:
      DOKPLOY_URL: ${DOKPLOY_URL:?URL de tu Dokploy, p.ej. https://dokploy.konectus.internal}
      DOKPLOY_API_KEY: ${DOKPLOY_API_KEY:?API key de Dokploy (Settings → Profile → API/CLI)}
      KEEL_ADMIN_PASSWORD: ${KEEL_ADMIN_PASSWORD:?Contraseña del admin, mínimo 12 caracteres}
      KEEL_CI_EXPIRY_MINUTES: ${KEEL_CI_EXPIRY_MINUTES:-60}
      KEEL_DEPLOY_TIMEOUT_MINUTES: ${KEEL_DEPLOY_TIMEOUT_MINUTES:-15}
    volumes:
      - keel-data:/data
    expose:
      - "3000"

volumes:
  keel-data:
```

- Usa una versión fija (`:v0.2.0`) en lugar de `:latest`, así un redeploy no cambia de versión sin que lo decidas. Para actualizar keel, cambia la tag y redespliega.
- `keel-data` es un volumen con nombre: la base (scopes, servicios, tokens de CI e historial) sobrevive a redeploys y actualizaciones de la imagen.
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

Debe devolver `{"ok":true}`. El admin queda en `https://keel.konectus.com/` (entra con `KEEL_ADMIN_PASSWORD`) y la API en `https://keel.konectus.com/api`, que es la URL que usas en `keel login` y en la variable `KEEL_API_URL` de cada repo.

> La GitHub Action tiene que poder llegar a `https://<dominio>/api/ci-result`. Con runners hospedados por GitHub, el dominio debe ser público (el resto de la API y el admin pueden protegerse aparte); si keel solo es accesible en una red interna, usa runners self-hosted dentro de esa red.

## Vincular un repo

1. Entra al admin (`https://<dominio>/`) con `KEEL_ADMIN_PASSWORD`.
2. **Nuevo scope**: pega la URL del repo de GitHub. Copia el token de CI que aparece (solo se muestra una vez).
3. En el scope, **vincula servicios** de Dokploy: un alias (lo que eliges en `keel deploy`, p.ej. `api-prod`) y la URL del servicio copiada del dashboard de Dokploy (`…/services/application/<id>` o `…/services/compose/<id>`). Para un Compose puedes indicar la variable del tag; si la dejas vacía es `DOCKER_TAG`.
4. En el repo de GitHub:
   - Copia [`templates/github/keel-release.yml`](templates/github/keel-release.yml) a `.github/workflows/` y reemplaza el paso `Test` por tus tests.
   - Variable `KEEL_API_URL` = `https://<dominio>/api`.
   - Secret `DEPLOY_API_TOKEN` = el token de CI del scope.
5. Prepara el servicio en Dokploy según su tipo:

   | Tipo        | Requisito                                                                                                       | Qué hace keel al desplegar `v1.4.0`                                              |
   | ----------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
   | Application | Proveedor **Docker** con imagen `<registry>/<owner>/<repo>:<algún tag>`                                          | Cambia la imagen a `…:v1.4.0` y despliega (conserva usuario y token de registry) |
   | Compose     | La imagen usa la variable del tag (`image: ${DOCKER_IMAGE}:${DOCKER_TAG}`) y esa variable está en Environment | Pone `DOCKER_TAG=v1.4.0` en Environment, sin tocar el resto, y redespliega       |

   En un Compose, todos los servicios que usan esa variable se actualizan juntos. Si la variable no está definida en el Environment, keel no despliega y marca el deploy como fallido con el motivo.

## Desarrollo

```bash
pnpm install
pnpm test        # vitest en todos los paquetes
pnpm typecheck
pnpm lint
pnpm build
```

```
apps/cli        CLI keel (TypeScript, empaquetada con tsup)
apps/server     Next.js: API (route handlers), admin y worker (instrumentation.ts), SQLite con node:sqlite
packages/shared Esquemas de la API y máquina de estados del deploy
deploy/         docker-compose de ejemplo para Dokploy
templates/      Workflow de GitHub para los repos que se despliegan con keel
```

Para el servidor en local, copia `apps/server/.env.example` a `apps/server/.env` y ejecuta `pnpm --filter @keel/server dev`.

### Publicar una versión de keel

Push de un tag `vX.Y.Z` → [`release.yml`](.github/workflows/release.yml) corre lint, typecheck y tests, publica la imagen del servidor en Docker Hub (`<DOCKERHUB_IMAGE>:vX.Y.Z` y `:latest`, linux/amd64) y adjunta `keel-cli.tgz` al GitHub Release.

Configuración del repo (Settings → Secrets and variables → Actions):

| Tipo      | Nombre               | Valor                                                        |
| --------- | -------------------- | ------------------------------------------------------------ |
| Variable  | `DOCKERHUB_IMAGE`    | `getfoundathyon/keel-api`                                    |
| Secret    | `DOCKERHUB_USERNAME` | `getfoundathyon`                                             |
| Secret    | `DOCKERHUB_TOKEN`    | Personal access token de Docker Hub con permiso Read & Write |

El token se crea en Docker Hub → Account settings → Personal access tokens.

## Limitaciones actuales

- Application solo con proveedor Docker; Compose solo si la imagen toma el tag de una variable de su Environment.
- `POST /api/deploys` no tiene autenticación: cualquiera que alcance la API puede pedir un deploy (solo se ejecuta si el CI de ese commit pasó).
- El worker corre dentro del proceso de Next.js: una sola réplica por instancia.
- Las carpetas `github.com:<org>` de `~/.keel` no son válidas en Windows.
