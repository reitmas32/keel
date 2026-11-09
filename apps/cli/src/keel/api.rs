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

/// A scope of a repo: a Dokploy service keel deploys to. Servers before
/// v0.5.0 only send `alias`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceSummary {
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

/// Who the token belongs to, from `GET /whoami`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhoAmI {
    pub name: Option<String>,
    pub auth: String,
}

impl ServiceSummary {
    /// The env variable a Compose takes its image tag from.
    pub fn tag_variable(&self) -> &str {
        self.tag_variable
            .as_deref()
            .filter(|v| !v.is_empty())
            .unwrap_or("DOCKER_TAG")
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDeploy<'a> {
    pub repo: &'a str,
    pub tag: &'a str,
    pub sha: &'a str,
    pub service: &'a str,
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
        self.request(
            reqwest::Method::PUT,
            &format!("/repos/{repo}/services/{}/lock", encode(alias)),
            Some(serde_json::json!({ "reason": reason })),
        )
        .await
        .map_err(locks_unsupported)
    }

    /// Lets deploys to a scope through again; returns whether it was locked.
    pub async fn unlock(&self, repo: &str, alias: &str) -> Result<bool> {
        let body = self
            .request_value(
                reqwest::Method::DELETE,
                &format!("/repos/{repo}/services/{}/lock", encode(alias)),
                None,
            )
            .await
            .map_err(locks_unsupported)?;
        Ok(body["wasLocked"].as_bool().unwrap_or(true))
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub async fn health(&self) -> Result<Value> {
        self.request_value(reqwest::Method::GET, "/health", None)
            .await
    }

    pub async fn list_service_summaries(&self, repo: &str) -> Result<Vec<ServiceSummary>> {
        #[derive(Deserialize)]
        struct Body {
            services: Vec<ServiceSummary>,
        }
        Ok(self
            .request::<Body>(
                reqwest::Method::GET,
                &format!("/repos/{repo}/services"),
                None,
            )
            .await?
            .services)
    }

    /// The raw answer of `/repos/<repo>/services`, for `--json`.
    pub async fn list_services_raw(&self, repo: &str) -> Result<Value> {
        let body = self
            .request_value(
                reqwest::Method::GET,
                &format!("/repos/{repo}/services"),
                None,
            )
            .await?;
        Ok(body
            .get("services")
            .cloned()
            .unwrap_or(Value::Array(vec![])))
    }

    pub async fn list_services(&self, repo: &str) -> Result<Vec<String>> {
        Ok(self
            .list_service_summaries(repo)
            .await?
            .into_iter()
            .map(|s| s.alias)
            .collect())
    }

    pub async fn create_deploy(&self, request: &CreateDeploy<'_>) -> Result<Deploy> {
        self.request(
            reqwest::Method::POST,
            "/deploys",
            Some(serde_json::to_value(request)?),
        )
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
        service: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Vec<Deploy>> {
        #[derive(Deserialize)]
        struct Body {
            deploys: Vec<Deploy>,
        }
        let mut query = Vec::new();
        if let Some(service) = service {
            query.push(format!("service={}", encode(service)));
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
        serde_json::from_value(value).map_err(|error| {
            fail(
                Kind::KeelUnreachable,
                format!("La API de keel respondió algo inesperado en {path}: {error}"),
            )
        })
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
        Ok(json.unwrap_or(Value::Null))
    }
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
                    .set_body_json(serde_json::json!({"error": "El servicio prod está bloqueado"})),
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
                service: "prod",
            })
            .await
            .unwrap_err();
        assert_eq!(crate::failure::report(&error).1, 31);
        assert_eq!(bearer("t"), "Bearer t");
    }

    #[tokio::test]
    async fn old_servers_have_no_whoami_or_locks() {
        let server = MockServer::start().await;
        let api = KeelApi::new(&server.uri()).unwrap();
        assert!(api.whoami().await.unwrap().is_none());
        let error = api.lock("a/b", "prod", "x").await.unwrap_err();
        assert!(error.to_string().contains("no soporta locks"));
    }

    #[tokio::test]
    async fn keel_errors_keep_their_message() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/deploys"))
            .respond_with(
                ResponseTemplate::new(404)
                    .set_body_json(serde_json::json!({"error": "El servicio x no existe"})),
            )
            .mount(&server)
            .await;
        let api = KeelApi::new(&server.uri()).unwrap();
        let error = api
            .create_deploy(&CreateDeploy {
                repo: "acme/app",
                tag: "v1.0.0",
                sha: "abcdef0",
                service: "x",
            })
            .await
            .unwrap_err();
        assert!(!is_unsupported(&error));
        assert_eq!(error.to_string(), "El servicio x no existe");
    }
}
