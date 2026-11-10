//! Client for a keel server (the org's `apiUrl`) and the shapes it answers.

use crate::failure::{Failure, Kind, fail, fail_with};
use anyhow::Result;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeployStatus {
    WaitingCi,
    CiPassed,
    Deploying,
    Deployed,
    CiFailed,
    DeployFailed,
    Expired,
}

impl DeployStatus {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Deployed | Self::CiFailed | Self::DeployFailed | Self::Expired
        )
    }

    pub fn is_failure(self) -> bool {
        matches!(self, Self::CiFailed | Self::DeployFailed | Self::Expired)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CiStatus {
    Pending,
    Success,
    Failure,
    Cancelled,
    Expired,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Deploy {
    pub id: String,
    pub repo: String,
    pub tag: String,
    pub sha: String,
    /// The scope (`prod`, `stg`…) it deploys to.
    pub scope: String,
    /// Same as `scope`: the name servers before v0.7.0 use, kept in `--json`.
    #[serde(default)]
    pub service: String,
    pub status: DeployStatus,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub ci_passed_at: Option<String>,
    #[serde(default)]
    pub deploy_started_at: Option<String>,
    #[serde(default)]
    pub finished_at: Option<String>,
    /// Name of the personal token that asked for it (servers with API tokens).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_by: Option<String>,
}

impl Deploy {
    /// When it reached its final state; servers before v0.3.0 only say it with `updatedAt`.
    pub fn finished(&self) -> Option<&str> {
        self.finished_at.as_deref().or(self
            .status
            .is_terminal()
            .then_some(self.updated_at.as_str()))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployDetail {
    #[serde(flatten)]
    pub deploy: Deploy,
    /// `application` or `compose`: what the scope points to in Dokploy.
    #[serde(default)]
    pub scope_kind: Option<String>,
    /// Same as `scope_kind`, under its pre-v0.7.0 name.
    #[serde(default)]
    pub service_kind: Option<String>,
    #[serde(default)]
    pub tag_variable: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub repo: String,
    pub tag: String,
    pub sha: String,
    pub branch: Option<String>,
    pub created_by_name: Option<String>,
    pub created_by_email: Option<String>,
    pub created_at: String,
    pub ci_status: CiStatus,
    pub ci_finished_at: Option<String>,
    pub run_url: Option<String>,
}

impl Version {
    pub fn author(&self) -> Option<&str> {
        self.created_by_name
            .as_deref()
            .or(self.created_by_email.as_deref())
    }
}

/// A scope of an app: an alias (`prod`, `stg`…) for the Dokploy application
/// or compose keel deploys to. Servers before v0.5.0 only send `alias`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeSummary {
    pub alias: String,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub tag_variable: Option<String>,
    #[serde(default)]
    pub dokploy_id: Option<String>,
    #[serde(default)]
    pub dokploy_url: Option<String>,
    #[serde(default)]
    pub dokploy_name: Option<String>,
    #[serde(default)]
    pub current: Option<Deploy>,
    #[serde(default)]
    pub last: Option<Deploy>,
    /// Set while deploys to the scope are frozen with `keel lock`.
    #[serde(default)]
    pub lock: Option<Lock>,
}

/// A frozen scope: keel refuses new deploys until `keel unlock`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lock {
    #[serde(default)]
    pub alias: Option<String>,
    pub reason: String,
    #[serde(default)]
    pub locked_by: Option<String>,
    pub created_at: String,
}

/// Who the token belongs to, from `GET /whoami`. Servers before members only
/// send `name` and `auth`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WhoAmI {
    pub name: Option<String>,
    pub auth: String,
    #[serde(default)]
    pub email: Option<String>,
    /// Base role (viewer, publisher, deployer, maintainer, admin), capped by the token.
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub grants: Vec<Grant>,
    #[serde(default)]
    pub token_max_role: Option<String>,
    /// Role keel gives calls without a token while auth is optional.
    #[serde(default)]
    pub anonymous_role: Option<String>,
}

/// A role on the apps and scopes that match the patterns (`*` globs).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Grant {
    pub repo: String,
    pub scope: String,
    /// Same as `scope`, under its pre-v0.7.0 name.
    #[serde(default)]
    pub service: String,
    pub role: String,
}

impl WhoAmI {
    /// `Ana (deployer)`, or just the name on servers without roles.
    pub fn label(&self) -> Option<String> {
        let name = self.name.clone()?;
        Some(match &self.role {
            Some(role) => format!("{name} ({role})"),
            None => name,
        })
    }
}

impl ScopeSummary {
    /// The env variable a Compose takes its image tag from.
    pub fn tag_variable(&self) -> &str {
        self.tag_variable
            .as_deref()
            .filter(|v| !v.is_empty())
            .unwrap_or("DOCKER_TAG")
    }
}

#[derive(Debug)]
pub struct CreateDeploy<'a> {
    pub repo: &'a str,
    pub tag: &'a str,
    pub sha: &'a str,
    pub scope: &'a str,
}

impl CreateDeploy<'_> {
    /// The body: the scope goes as `scope` and, for servers before v0.7.0, as `service`.
    fn body(&self) -> Value {
        serde_json::json!({
            "repo": self.repo, "tag": self.tag, "sha": self.sha,
            "scope": self.scope, "service": self.scope,
        })
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterVersion<'a> {
    pub repo: &'a str,
    pub tag: &'a str,
    pub sha: &'a str,
    pub branch: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_by_name: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_by_email: Option<&'a str>,
}

/// Whether an error is a keel route the server does not have: a 404 that is
/// not one of keel's own `{error}` answers, so the server is older than the CLI.
pub fn is_unsupported(error: &anyhow::Error) -> bool {
    error
        .chain()
        .find_map(|e| e.downcast_ref::<Failure>())
        .and_then(|f| f.details.as_ref())
        .is_some_and(|d| {
            (d["http_status"] == 404 || d["http_status"] == 405) && d["from_keel"] == false
        })
}

/// Fills in both names of the fields v0.7.0 renamed (`scope`/`service`,
/// `scopes`/`services`, `scopeKind`/`serviceKind`), so the CLI reads `scope`
/// from any server and `--json` keeps the old keys for scripts.
pub fn normalize(value: &mut Value) {
    const PAIRS: [(&str, &str); 3] = [
        ("scope", "service"),
        ("scopes", "services"),
        ("scopeKind", "serviceKind"),
    ];
    match value {
        Value::Object(map) => {
            for (new, old) in PAIRS {
                match (map.get(new).cloned(), map.get(old).cloned()) {
                    (None, Some(v)) => {
                        map.insert(new.to_owned(), v);
                    }
                    (Some(v), None) => {
                        map.insert(old.to_owned(), v);
                    }
                    _ => {}
                }
            }
            map.values_mut().for_each(normalize);
        }
        Value::Array(items) => items.iter_mut().for_each(normalize),
        _ => {}
    }
}

/// API URLs whose server only has the pre-v0.7.0 `/services` routes, so the
/// rest of the process goes straight to them.
fn legacy_routes() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    static LEGACY: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    LEGACY.get_or_init(Default::default)
}

pub struct KeelApi {
    base_url: String,
    token: Option<String>,
    http: reqwest::Client,
}

/// The personal token to send: `KEEL_TOKEN` wins over the one saved by `keel login`.
pub fn effective_token(saved: Option<&str>) -> Option<String> {
    std::env::var("KEEL_TOKEN")
        .ok()
        .or_else(|| saved.map(str::to_owned))
        .map(|t| t.trim().to_owned())
        .filter(|t| !t.is_empty())
}

/// The `Authorization` header value for a token.
pub fn bearer(token: &str) -> String {
    format!("Bearer {token}")
}

impl KeelApi {
    pub fn new(base_url: &str) -> Result<Self> {
        Self::with_token(base_url, None)
    }

    /// The API of an org, with its token (or `KEEL_TOKEN`).
    pub fn for_org(org: &crate::keel::config::OrgConfig) -> Result<Self> {
        Self::with_token(&org.api_url, effective_token(org.token.as_deref()))
    }

    pub fn with_token(base_url: &str, token: Option<String>) -> Result<Self> {
        let http = reqwest::Client::builder()
            .user_agent(concat!("keel-cli/", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(30))
            .build()?;
        Ok(Self {
            base_url: base_url.trim_end_matches('/').to_owned(),
            token,
            http,
        })
    }

    pub fn has_token(&self) -> bool {
        self.token.is_some()
    }

    /// Who keel thinks we are; `None` when the server predates API tokens.
    pub async fn whoami(&self) -> Result<Option<WhoAmI>> {
        match self
            .request::<WhoAmI>(reqwest::Method::GET, "/whoami", None)
            .await
        {
            Ok(who) => Ok(Some(who)),
            Err(error) if is_unsupported(&error) => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// Freezes deploys to a scope.
    pub async fn lock(&self, repo: &str, alias: &str, reason: &str) -> Result<Lock> {
        let path = format!("/{}/lock", encode(alias));
        let body = self
            .scopes_route(
                reqwest::Method::PUT,
                repo,
                &path,
                Some(serde_json::json!({ "reason": reason })),
            )
            .await
            .map_err(locks_unsupported)?;
        parse(body, &format!("/repos/{repo}/scopes{path}"))
    }

    /// Lets deploys to a scope through again; returns whether it was locked.
    pub async fn unlock(&self, repo: &str, alias: &str) -> Result<bool> {
        let path = format!("/{}/lock", encode(alias));
        let body = self
            .scopes_route(reqwest::Method::DELETE, repo, &path, None)
            .await
            .map_err(locks_unsupported)?;
        Ok(body["wasLocked"].as_bool().unwrap_or(true))
    }

    /// `/repos/<repo>/scopes<rest>`, or the same under `/services` when the
    /// server predates v0.7.0 (a 404/405 that is not a keel error). Once a
    /// server needs the old route, the rest of the process goes straight to it.
    async fn scopes_route(
        &self,
        method: reqwest::Method,
        repo: &str,
        rest: &str,
        body: Option<Value>,
    ) -> Result<Value> {
        let legacy = legacy_routes()
            .lock()
            .is_ok_and(|l| l.contains(&self.base_url));
        if !legacy {
            match self
                .request_value(
                    method.clone(),
                    &format!("/repos/{repo}/scopes{rest}"),
                    body.clone(),
                )
                .await
            {
                Err(error) if is_unsupported(&error) => {
                    if let Ok(mut l) = legacy_routes().lock() {
                        l.insert(self.base_url.clone());
                    }
                }
                other => return other,
            }
        }
        self.request_value(method, &format!("/repos/{repo}/services{rest}"), body)
            .await
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub async fn health(&self) -> Result<Value> {
        self.request_value(reqwest::Method::GET, "/health", None)
            .await
    }

    /// The scopes of an app (`GET /repos/<repo>/scopes`, or `/services` before v0.7.0).
    pub async fn list_scope_summaries(&self, repo: &str) -> Result<Vec<ScopeSummary>> {
        #[derive(Deserialize)]
        struct Body {
            #[serde(default)]
            scopes: Vec<ScopeSummary>,
        }
        let body = self
            .scopes_route(reqwest::Method::GET, repo, "", None)
            .await?;
        Ok(parse::<Body>(body, &format!("/repos/{repo}/scopes"))?.scopes)
    }

    /// The raw list of scopes, for `--json` (each deploy with `scope` and `service`).
    pub async fn list_scopes_raw(&self, repo: &str) -> Result<Value> {
        let body = self
            .scopes_route(reqwest::Method::GET, repo, "", None)
            .await?;
        Ok(body.get("scopes").cloned().unwrap_or(Value::Array(vec![])))
    }

    /// The aliases of an app's scopes.
    pub async fn list_scopes(&self, repo: &str) -> Result<Vec<String>> {
        Ok(self
            .list_scope_summaries(repo)
            .await?
            .into_iter()
            .map(|s| s.alias)
            .collect())
    }

    pub async fn create_deploy(&self, request: &CreateDeploy<'_>) -> Result<Deploy> {
        self.request(reqwest::Method::POST, "/deploys", Some(request.body()))
            .await
    }

    pub async fn get_deploy(&self, id: &str) -> Result<Deploy> {
        self.request(
            reqwest::Method::GET,
            &format!("/deploys/{}", encode(id)),
            None,
        )
        .await
    }

    pub async fn list_deploys(
        &self,
        repo: &str,
        scope: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Vec<Deploy>> {
        #[derive(Deserialize)]
        struct Body {
            deploys: Vec<Deploy>,
        }
        let mut query = Vec::new();
        // `service` too: servers before v0.7.0 ignore `scope` and would list them all.
        if let Some(scope) = scope {
            query.push(format!("scope={}", encode(scope)));
            query.push(format!("service={}", encode(scope)));
        }
        if let Some(limit) = limit {
            query.push(format!("limit={limit}"));
        }
        let suffix = if query.is_empty() {
            String::new()
        } else {
            format!("?{}", query.join("&"))
        };
        Ok(self
            .request::<Body>(
                reqwest::Method::GET,
                &format!("/repos/{repo}/deploys{suffix}"),
                None,
            )
            .await?
            .deploys)
    }

    /// Registers a version `create-version` just pushed (servers ≥ v0.4.0).
    pub async fn register_version(&self, request: &RegisterVersion<'_>) -> Result<Version> {
        self.request(
            reqwest::Method::POST,
            "/versions",
            Some(serde_json::to_value(request)?),
        )
        .await
    }

    /// Newest first; `None` when the server is older than v0.4.0.
    pub async fn list_versions(
        &self,
        repo: &str,
        limit: Option<u32>,
    ) -> Result<Option<Vec<Version>>> {
        #[derive(Deserialize)]
        struct Body {
            versions: Vec<Version>,
        }
        let suffix = limit.map(|l| format!("?limit={l}")).unwrap_or_default();
        match self
            .request::<Body>(
                reqwest::Method::GET,
                &format!("/repos/{repo}/versions{suffix}"),
                None,
            )
            .await
        {
            Ok(body) => Ok(Some(body.versions)),
            Err(error) if is_unsupported(&error) => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// One deploy of `repo` by its id or a unique prefix (at least 4 characters).
    pub async fn get_repo_deploy(&self, repo: &str, id_prefix: &str) -> Result<DeployDetail> {
        self.request(
            reqwest::Method::GET,
            &format!("/repos/{repo}/deploys/{}", encode(id_prefix)),
            None,
        )
        .await
    }

    async fn request<T: DeserializeOwned>(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<T> {
        let value = self.request_value(method, path, body).await?;
        parse(value, path)
    }

    pub async fn request_value(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value> {
        let url = format!("{}{path}", self.base_url);
        let mut request = self
            .http
            .request(method, &url)
            .header("accept", "application/json");
        if let Some(token) = &self.token {
            request = request.header("authorization", bearer(token));
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|error| {
            fail(
                Kind::KeelUnreachable,
                format!(
                    "No se pudo conectar con la API de keel en {}: {}",
                    self.base_url,
                    root_cause(&error)
                ),
            )
        })?;
        let status = response.status();
        let json: Option<Value> = response.json().await.ok();
        if !status.is_success() {
            let keel_error = json
                .as_ref()
                .and_then(|j| j.get("error"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            let from_keel = keel_error.is_some();
            let code = status.as_u16();
            let unsupported = (code == 404 || code == 405) && !from_keel;
            let kind = match code {
                401 => Kind::Unauthorized,
                403 if from_keel => Kind::Forbidden,
                423 => Kind::Locked,
                _ if unsupported => Kind::KeelUnreachable,
                _ => Kind::Error,
            };
            let message = match (code, keel_error) {
                // Newer servers already say how to get a token; don't repeat it.
                (401, Some(error)) if error.contains("keel login") => {
                    format!("{} (o exporta KEEL_TOKEN).", error.trim_end_matches('.'))
                }
                (401, error) => format!(
                    "keel rechazó la petición ({}). Crea un token en el admin de keel, en «Tokens de API», y guárdalo con `keel login --token <token>` (o exporta KEEL_TOKEN).",
                    error.unwrap_or_else(|| if self.token.is_some() {
                        "token inválido o revocado".to_owned()
                    } else {
                        "este servidor exige un token personal".to_owned()
                    })
                ),
                (_, Some(error)) => error,
                (_, None) => format!("La API de keel respondió {code} en {path}."),
            };
            return Err(fail_with(
                kind,
                message,
                serde_json::json!({"http_status": status.as_u16(), "from_keel": from_keel}),
            ));
        }
        let mut json = json.unwrap_or(Value::Null);
        normalize(&mut json);
        Ok(json)
    }
}

// ------------------------------------------------------------- linking repos

/// The CI token of an app (`ciToken`). keel shows it only once, so it lives in
/// memory only: no `Serialize`, and `Debug` never prints it.
#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(transparent)]
pub struct CiToken(String);

impl CiToken {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// The value, for the one place that needs it (stdin of `gh secret set`).
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for CiToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CiToken(***)")
    }
}

/// An app of keel: a GitHub repo linked to its Dokploy scopes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct App {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    pub repo: String,
    #[serde(default)]
    pub created_at: Option<String>,
}

/// `GET /repos/<repo>`: the app and its scopes (same items as `GET …/scopes`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkedRepo {
    pub app: App,
    #[serde(default)]
    pub scopes: Vec<Value>,
}

impl LinkedRepo {
    pub fn aliases(&self) -> Vec<String> {
        self.scopes
            .iter()
            .filter_map(|s| s["alias"].as_str().map(str::to_owned))
            .collect()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedApp {
    pub app: App,
    pub ci_token: CiToken,
}

/// Which app and scope a Dokploy service already belongs to.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceLink {
    pub repo: String,
    pub scope: String,
}

/// An application or compose of the Dokploy keel deploys to.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DokployService {
    /// `application` or `compose`.
    pub kind: String,
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub app_name: Option<String>,
    #[serde(default)]
    pub project: String,
    #[serde(default)]
    pub environment: String,
    #[serde(default)]
    pub dashboard_url: Option<String>,
    #[serde(default)]
    pub linked: Option<ServiceLink>,
    /// Any registry Dokploy pulls the image with, when the server says so.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registry: Option<Value>,
}

impl DokployService {
    /// `Shop / production / web`
    pub fn path(&self) -> String {
        format!("{} / {} / {}", self.project, self.environment, self.name)
    }
}

/// What an old server (v0.7.0) answers to the routes that link repos.
pub const LINK_UNSUPPORTED: &str = "Tu servidor de keel no puede vincular repos desde la CLI (actualízalo a v0.8.0 o usa el admin).";

/// An unsupported route becomes [`LINK_UNSUPPORTED`]; other errors pass through.
pub fn link_unsupported(error: anyhow::Error) -> anyhow::Error {
    if !is_unsupported(&error) {
        return error;
    }
    let details = error
        .chain()
        .find_map(|e| e.downcast_ref::<Failure>())
        .and_then(|f| f.details.clone())
        .unwrap_or_default();
    fail_with(Kind::KeelUnreachable, LINK_UNSUPPORTED, details)
}

/// The HTTP status of a keel error, if it came from the API.
pub fn http_status(error: &anyhow::Error) -> Option<u16> {
    error
        .chain()
        .find_map(|e| e.downcast_ref::<Failure>())
        .and_then(|f| f.details.as_ref())
        .and_then(|d| d["http_status"].as_u64())
        .and_then(|s| u16::try_from(s).ok())
}

/// Whether the error is one of keel's own `{error}` answers.
pub fn from_keel(error: &anyhow::Error) -> bool {
    error
        .chain()
        .find_map(|e| e.downcast_ref::<Failure>())
        .and_then(|f| f.details.as_ref())
        .is_some_and(|d| d["from_keel"] == true)
}

impl KeelApi {
    /// The app linked to `repo`, `None` when keel says it isn't linked. A server
    /// without the route fails with [`is_unsupported`] (callers may fall back).
    pub async fn get_repo(&self, repo: &str) -> Result<Option<LinkedRepo>> {
        let path = format!("/repos/{repo}");
        match self.request_value(reqwest::Method::GET, &path, None).await {
            Ok(body) => Ok(Some(parse(body, &path)?)),
            Err(error) if http_status(&error) == Some(404) && from_keel(&error) => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// Links `repo` as a new app (admin). The CI token comes back only here.
    pub async fn create_app(&self, repo: &str, name: Option<&str>) -> Result<CreatedApp> {
        let mut body = serde_json::json!({ "repo": repo });
        if let Some(name) = name {
            body["name"] = Value::from(name);
        }
        let value = self
            .request_value(reqwest::Method::POST, "/apps", Some(body))
            .await
            .map_err(link_unsupported)?;
        parse(value, "/apps")
    }

    /// A new CI token for the app (maintainer); the previous one stops working.
    pub async fn rotate_ci_token(&self, repo: &str) -> Result<CiToken> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Body {
            ci_token: CiToken,
        }
        let path = format!("/repos/{repo}/ci-token");
        let value = self
            .request_value(reqwest::Method::POST, &path, None)
            .await
            .map_err(link_unsupported)?;
        Ok(parse::<Body>(value, &path)?.ci_token)
    }

    /// Adds a scope to the app (maintainer); answers the new scope item.
    pub async fn create_scope(&self, repo: &str, body: Value) -> Result<Value> {
        self.request_value(
            reqwest::Method::POST,
            &format!("/repos/{repo}/scopes"),
            Some(body),
        )
        .await
        .map_err(link_unsupported)
    }

    /// Every application and compose of the org's Dokploy (maintainer).
    pub async fn dokploy_services(&self) -> Result<Vec<DokployService>> {
        #[derive(Deserialize)]
        struct Body {
            services: Vec<DokployService>,
        }
        let value = self
            .request_value(reqwest::Method::GET, "/dokploy/services", None)
            .await
            .map_err(link_unsupported)?;
        Ok(parse::<Body>(value, "/dokploy/services")?.services)
    }
}

/// A keel answer as `T`.
fn parse<T: DeserializeOwned>(value: Value, path: &str) -> Result<T> {
    serde_json::from_value(value).map_err(|error| {
        fail(
            Kind::KeelUnreachable,
            format!("La API de keel respondió algo inesperado en {path}: {error}"),
        )
    })
}

/// A lock route the server does not have becomes a clear message.
fn locks_unsupported(error: anyhow::Error) -> anyhow::Error {
    let details = error
        .chain()
        .find_map(|e| e.downcast_ref::<Failure>())
        .and_then(|f| f.details.clone());
    let unsupported = details.as_ref().is_some_and(|d| {
        (d["http_status"] == 404 || d["http_status"] == 405) && d["from_keel"] == false
    });
    if unsupported {
        return fail_with(
            Kind::KeelUnreachable,
            "Este servidor de keel no soporta locks; actualízalo.",
            details.unwrap_or_default(),
        );
    }
    error
}

fn root_cause(error: &(dyn std::error::Error + 'static)) -> String {
    let mut current = error;
    while let Some(source) = current.source() {
        current = source;
    }
    current.to_string()
}

/// Percent-encodes a path segment or query value.
fn encode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn old_servers_without_versions_answer_none() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/repos/acme/app/versions"))
            .respond_with(ResponseTemplate::new(404).set_body_string("Not Found"))
            .mount(&server)
            .await;
        let api = KeelApi::new(&server.uri()).unwrap();
        assert!(api.list_versions("acme/app", None).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn sends_the_token_and_maps_401_and_423() {
        use wiremock::matchers::header;
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/whoami"))
            .and(header("authorization", "Bearer keel_pat_ok"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"name": "rafa", "auth": "optional"})),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/whoami"))
            .respond_with(
                ResponseTemplate::new(401)
                    .set_body_json(serde_json::json!({"error": "Token inválido."})),
            )
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/deploys"))
            .respond_with(
                ResponseTemplate::new(423)
                    .set_body_json(serde_json::json!({"error": "El scope prod está bloqueado"})),
            )
            .mount(&server)
            .await;
        let ok = KeelApi::with_token(&server.uri(), Some("keel_pat_ok".into())).unwrap();
        assert_eq!(
            ok.whoami().await.unwrap().unwrap().name.as_deref(),
            Some("rafa")
        );
        let bad = KeelApi::with_token(&server.uri(), Some("keel_pat_bad".into())).unwrap();
        let error = bad.whoami().await.unwrap_err();
        assert_eq!(crate::failure::report(&error).1, 29);
        assert!(error.to_string().contains("Tokens de API"));
        let error = ok
            .create_deploy(&CreateDeploy {
                repo: "a/b",
                tag: "v1.0.0",
                sha: "abcdef0",
                scope: "prod",
            })
            .await
            .unwrap_err();
        assert_eq!(crate::failure::report(&error).1, 31);
        assert_eq!(bearer("t"), "Bearer t");
    }

    #[tokio::test]
    async fn roles_come_from_whoami_and_403_is_forbidden() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/whoami"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "name": "ana", "email": "ana@acme.dev", "role": "deployer", "auth": "required",
                "grants": [{"repo": "*", "service": "prod*", "role": "viewer"}],
                "tokenMaxRole": null, "anonymousRole": "none"
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/deploys"))
            .respond_with(ResponseTemplate::new(403).set_body_json(
                serde_json::json!({"error": "Tu rol (viewer) no permite desplegar en a/b/prod."}),
            ))
            .mount(&server)
            .await;
        let api = KeelApi::with_token(&server.uri(), Some("keel_pat_ok".into())).unwrap();
        let who = api.whoami().await.unwrap().unwrap();
        assert_eq!(who.label().as_deref(), Some("ana (deployer)"));
        assert_eq!(who.grants[0].scope, "prod*");
        let error = api
            .create_deploy(&CreateDeploy {
                repo: "a/b",
                tag: "v1.0.0",
                sha: "abcdef0",
                scope: "prod",
            })
            .await
            .unwrap_err();
        let (report, code) = crate::failure::report(&error);
        assert_eq!(code, 33);
        assert_eq!(report["error"]["kind"], "forbidden");
        assert!(error.to_string().contains("Tu rol (viewer)"));
    }

    #[tokio::test]
    async fn old_servers_have_no_whoami_or_locks() {
        let server = MockServer::start().await;
        let api = KeelApi::new(&server.uri()).unwrap();
        assert!(api.whoami().await.unwrap().is_none());
        let error = api.lock("a/b", "prod", "x").await.unwrap_err();
        assert!(error.to_string().contains("no soporta locks"));
    }

    #[test]
    fn normalize_fills_both_names() {
        let mut old = serde_json::json!({"repo": "a/b", "services": [
            {"alias": "prod", "current": {"service": "prod"}}
        ]});
        normalize(&mut old);
        assert_eq!(old["scopes"][0]["current"]["scope"], "prod");
        assert_eq!(old["services"][0]["current"]["service"], "prod");
        let mut new = serde_json::json!({"scope": "stg", "scopeKind": "compose"});
        normalize(&mut new);
        assert_eq!(new["service"], "stg");
        assert_eq!(new["serviceKind"], "compose");
    }

    #[tokio::test]
    async fn falls_back_to_the_services_routes_of_v0_6_servers() {
        use wiremock::matchers::query_param;
        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(path("/repos/a/b/services/prod/lock"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "alias": "prod", "reason": "x", "createdAt": "2026-11-09T10:00:00Z"
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/repos/a/b/services"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "repo": "a/b", "services": [{"alias": "prod"}]
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/repos/a/b/deploys"))
            .and(query_param("scope", "prod"))
            .and(query_param("service", "prod"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "deploys": [{"id": "d1", "repo": "a/b", "tag": "v1.0.0", "sha": "abc",
                    "service": "prod", "status": "deployed", "error": null,
                    "createdAt": "2026-11-09T10:00:00Z", "updatedAt": "2026-11-09T10:00:00Z"}]
            })))
            .mount(&server)
            .await;
        let api = KeelApi::new(&server.uri()).unwrap();
        assert_eq!(api.lock("a/b", "prod", "x").await.unwrap().reason, "x");
        assert_eq!(api.list_scopes("a/b").await.unwrap(), ["prod"]);
        let deploys = api.list_deploys("a/b", Some("prod"), None).await.unwrap();
        assert_eq!(
            (deploys[0].scope.as_str(), deploys[0].service.as_str()),
            ("prod", "prod")
        );
        // /scopes was tried once; after that the process goes straight to /services.
        let tried = server
            .received_requests()
            .await
            .unwrap()
            .iter()
            .filter(|r| r.url.path().contains("/scopes"))
            .count();
        assert_eq!(tried, 1);
    }

    #[tokio::test]
    async fn a_keel_404_on_the_new_route_does_not_fall_back() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/repos/a/b/scopes"))
            .respond_with(
                ResponseTemplate::new(404)
                    .set_body_json(serde_json::json!({"error": "La app a/b no existe"})),
            )
            .mount(&server)
            .await;
        let api = KeelApi::new(&server.uri()).unwrap();
        let error = api.list_scopes("a/b").await.unwrap_err();
        assert_eq!(error.to_string(), "La app a/b no existe");
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn keel_errors_keep_their_message() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/deploys"))
            .respond_with(
                ResponseTemplate::new(404)
                    .set_body_json(serde_json::json!({"error": "El scope x no existe"})),
            )
            .mount(&server)
            .await;
        let api = KeelApi::new(&server.uri()).unwrap();
        let error = api
            .create_deploy(&CreateDeploy {
                repo: "acme/app",
                tag: "v1.0.0",
                sha: "abcdef0",
                scope: "x",
            })
            .await
            .unwrap_err();
        assert!(!is_unsupported(&error));
        assert_eq!(error.to_string(), "El scope x no existe");
    }
}
