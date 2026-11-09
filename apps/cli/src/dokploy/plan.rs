use crate::dokploy::{
    audit,
    client::{ServiceAction, ServiceKind, WriteEndpoint},
};
use crate::failure::{Kind, fail};
use anyhow::{Context, Result, bail};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Plan {
    pub version: u8,
    pub id: Uuid,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub organization: String,
    pub instance: String,
    pub action: PlannedAction,
    pub digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PlannedAction {
    ComposeUpdate {
        compose_id: String,
        compose_file: String,
        content_sha256: String,
        base_remote_sha256: String,
        /// Sanitized unified diff against the remote file, for the summary.
        #[serde(default)]
        diff: Option<String>,
        /// Things the reviewer should know (e.g. a keel scope losing its tag variable).
        #[serde(default)]
        warnings: Vec<String>,
        /// Redeploy the Compose right after saving the file.
        #[serde(default)]
        redeploy: bool,
    },
    PostgresCreate {
        environment_id: String,
        name: String,
        database_name: String,
        database_user: String,
        password_env: String,
        docker_image: Option<String>,
        server_id: Option<String>,
    },
    /// Creates a Mongo database. The password is only read at apply time, and
    /// an optional memory limit is set with a second call, as `mongo.create`
    /// does not take it.
    MongoCreate {
        environment_id: String,
        server_id: Option<String>,
        name: String,
        description: Option<String>,
        database_user: String,
        password_env: String,
        docker_image: String,
        memory_limit_bytes: Option<u64>,
    },
    /// Adds a scheduled native backup to a database service.
    BackupCreate {
        service_kind: ServiceKind,
        service_id: String,
        label: String,
        database_type: String,
        database: String,
        destination_id: String,
        destination: String,
        schedule: String,
        prefix: String,
        keep_latest_count: u32,
    },
    /// deploy, redeploy, start or stop one service.
    ServiceAction {
        service_kind: ServiceKind,
        service_id: String,
        label: String,
        action: ServiceAction,
    },
    /// Replaces the whole env block of a service. The current block is backed
    /// up (owner-only) right before the change, and the change is refused if
    /// the remote env moved since the plan was made.
    EnvSet {
        service_kind: ServiceKind,
        service_id: String,
        label: String,
        env: String,
        keys: Vec<String>,
        env_sha256: String,
        base_env_sha256: String,
        /// Which keys are added, changed or removed, with value lengths only
        /// (env-patch and env-restore fill it in).
        #[serde(default)]
        key_changes: Option<Value>,
        /// How the plan was made: env-set, env-patch or env-restore.
        #[serde(default)]
        origin: Option<String>,
        /// Redeploy the service right after saving the env.
        #[serde(default)]
        redeploy: bool,
    },
    /// Adds a volume, bind mount or file mount to a service.
    MountCreate {
        service_kind: ServiceKind,
        service_id: String,
        label: String,
        mount_type: String,
        mount_path: String,
        host_path: Option<String>,
        volume_name: Option<String>,
        /// Content of a file mount; shown in the summary only as its length.
        file_content: Option<String>,
        #[serde(default)]
        redeploy: bool,
    },
    /// Creates a raw Compose. Dokploy creates it with a git source, so apply
    /// also sets `sourceType: raw` on the new Compose.
    ComposeCreate {
        environment_id: String,
        server_id: Option<String>,
        name: String,
        description: Option<String>,
        compose_file: String,
        content_sha256: String,
    },
    /// Changes Compose settings that are not its file: source type, name, description.
    ComposeSettings {
        compose_id: String,
        label: String,
        source_type: Option<String>,
        name: Option<String>,
        description: Option<String>,
    },
    /// A POST to a procedure listed in `security.raw_post_allowlist`.
    RawPost { procedure: String, body: Value },
}

impl PlannedAction {
    pub fn endpoint(&self) -> WriteEndpoint {
        match self {
            Self::ComposeUpdate { .. } | Self::ComposeSettings { .. } => {
                WriteEndpoint::ComposeUpdate
            }
            Self::PostgresCreate { .. } => WriteEndpoint::PostgresCreate,
            Self::MongoCreate { .. } => WriteEndpoint::MongoCreate,
            Self::BackupCreate { .. } => WriteEndpoint::BackupCreate,
            Self::ServiceAction {
                service_kind,
                action,
                ..
            } => WriteEndpoint::Action(*service_kind, *action),
            Self::EnvSet { service_kind, .. } => WriteEndpoint::SaveEnvironment(*service_kind),
            Self::MountCreate { .. } => WriteEndpoint::MountCreate,
            Self::ComposeCreate { .. } => WriteEndpoint::ComposeCreate,
            Self::RawPost { procedure, .. } => WriteEndpoint::Raw(procedure.clone()),
        }
    }
    pub fn operation_name(&self) -> String {
        match self.redeploy_after() {
            Some((kind, _)) => format!(
                "{}+{}",
                self.endpoint().path(),
                WriteEndpoint::Action(kind, kind.redeploy_action()).path()
            ),
            None => self.endpoint().path(),
        }
    }

    /// The service a plan redeploys after its change (`--redeploy`).
    pub fn redeploy_after(&self) -> Option<(ServiceKind, String)> {
        match self {
            Self::ComposeUpdate {
                compose_id,
                redeploy: true,
                ..
            } => Some((ServiceKind::Compose, compose_id.clone())),
            Self::EnvSet {
                service_kind,
                service_id,
                redeploy: true,
                ..
            }
            | Self::MountCreate {
                service_kind,
                service_id,
                redeploy: true,
                ..
            } => Some((*service_kind, service_id.clone())),
            _ => None,
        }
    }
    pub fn safe_summary(&self) -> Value {
        match self {
            Self::ComposeUpdate {
                compose_id,
                content_sha256,
                base_remote_sha256,
                diff,
                warnings,
                redeploy,
                ..
            } => {
                let mut summary = json!({"compose_id": compose_id, "content_sha256": content_sha256, "base_remote_sha256": base_remote_sha256, "redeploy": redeploy});
                if let Some(diff) = diff {
                    summary["diff"] = json!(diff);
                }
                if !warnings.is_empty() {
                    summary["warnings"] = json!(warnings);
                }
                summary
            }
            Self::PostgresCreate {
                environment_id,
                name,
                database_name,
                database_user,
                password_env,
                docker_image,
                server_id,
            } => json!({
                "environment_id": environment_id, "name": name, "database_name": database_name, "database_user": database_user,
                "password_env": password_env, "docker_image": docker_image, "server_id": server_id
            }),
            Self::MongoCreate {
                environment_id,
                server_id,
                name,
                description,
                database_user,
                password_env,
                docker_image,
                memory_limit_bytes,
            } => json!({
                "environment_id": environment_id, "server_id": server_id, "name": name,
                "description": description, "database_user": database_user,
                "password_env": password_env, "docker_image": docker_image,
                "memory_limit_bytes": memory_limit_bytes
            }),
            Self::BackupCreate {
                service_kind,
                service_id,
                label,
                database,
                destination_id,
                destination,
                schedule,
                prefix,
                keep_latest_count,
                ..
            } => json!({
                "service": label, "kind": service_kind, "service_id": service_id,
                "database": database, "destination": destination,
                "destination_id": destination_id, "schedule": schedule, "prefix": prefix,
                "keep_latest_count": keep_latest_count
            }),
            Self::ServiceAction {
                service_kind,
                service_id,
                label,
                action,
            } => {
                json!({"service": label, "kind": service_kind, "service_id": service_id, "action": action})
            }
            Self::EnvSet {
                service_kind,
                service_id,
                label,
                keys,
                env_sha256,
                base_env_sha256,
                key_changes,
                origin,
                redeploy,
                ..
            } => {
                let mut summary = json!({
                    "service": label, "kind": service_kind, "service_id": service_id,
                    "replaces_all_variables_with": keys, "env_sha256": env_sha256, "base_env_sha256": base_env_sha256,
                    "redeploy": redeploy,
                    "note": if *redeploy {
                        "los valores quedan en el archivo protegido del plan; el env actual se respalda antes del cambio y luego se redespliega el servicio"
                    } else {
                        "los valores quedan en el archivo protegido del plan; el env actual se respalda antes del cambio y el nuevo aplica en el próximo deploy"
                    }
                });
                if let Some(changes) = key_changes {
                    summary["key_changes"] = changes.clone();
                }
                if let Some(origin) = origin {
                    summary["origin"] = json!(origin);
                }
                summary
            }
            Self::MountCreate {
                service_kind,
                service_id,
                label,
                mount_type,
                mount_path,
                host_path,
                volume_name,
                file_content,
                redeploy,
            } => json!({
                "service": label, "kind": service_kind, "service_id": service_id,
                "type": mount_type, "mount_path": mount_path, "host_path": host_path,
                "volume_name": volume_name,
                "file_content_length": file_content.as_ref().map(|c| c.chars().count()),
                "redeploy": redeploy,
                "note": if *redeploy { "el servicio se redespliega para tomar el mount" } else { "el mount aplica en el próximo deploy" }
            }),
            Self::ComposeCreate {
                environment_id,
                server_id,
                name,
                description,
                compose_file,
                content_sha256,
            } => json!({
                "name": name, "description": description, "environment_id": environment_id, "server_id": server_id,
                "content_sha256": content_sha256, "services": compose_services(compose_file), "source_type": "raw"
            }),
            Self::ComposeSettings {
                compose_id,
                label,
                source_type,
                name,
                description,
            } => {
                json!({"service": label, "compose_id": compose_id, "source_type": source_type, "name": name, "description": description})
            }
            Self::RawPost { procedure, body } => {
                json!({"procedure": procedure, "body": crate::dokploy::redact::redact(body.clone())})
            }
        }
    }
}

/// Service names of a Compose file, for a plan summary that shows what will
/// run without printing the file (which can embed secrets).
fn compose_services(content: &str) -> Vec<String> {
    serde_yaml::from_str::<serde_yaml::Value>(content)
        .ok()
        .and_then(|yaml| yaml.get("services").and_then(|s| s.as_mapping()).cloned())
        .map(|services| {
            services
                .keys()
                .filter_map(|key| key.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

impl Plan {
    pub fn new(
        organization: String,
        instance: String,
        action: PlannedAction,
        ttl_seconds: u64,
    ) -> Result<Self> {
        let created_at = Utc::now();
        let expires_at = created_at + Duration::seconds(ttl_seconds.try_into()?);
        let id = Uuid::new_v4();
        let digest = digest_fields(
            1,
            id,
            created_at,
            expires_at,
            &organization,
            &instance,
            &action,
        )?;
        Ok(Self {
            version: 1,
            id,
            created_at,
            expires_at,
            organization,
            instance,
            action,
            digest,
        })
    }
    pub fn verify(&self) -> Result<()> {
        if self.version != 1 {
            bail!("unsupported plan version");
        }
        if self.expires_at <= Utc::now() {
            return Err(fail(
                Kind::PlanUnavailable,
                "el plan caducó; genera y revisa uno nuevo",
            ));
        }
        let expected = digest_fields(
            self.version,
            self.id,
            self.created_at,
            self.expires_at,
            &self.organization,
            &self.instance,
            &self.action,
        )?;
        if expected != self.digest {
            bail!("falló la verificación de integridad del plan");
        }
        Ok(())
    }
    pub fn safe_output(&self) -> Value {
        json!({
            "plan_id": self.id, "expires_at": self.expires_at, "organization": self.organization, "instance": self.instance,
            "operation": self.action.operation_name(), "changes": self.action.safe_summary(), "approval_token_sha256": self.digest,
            "next_step": "Una persona debe revisar este plan y luego usar apply con el approval_token_sha256 exacto antes de que caduque."
        })
    }
}

fn digest_fields(
    version: u8,
    id: Uuid,
    created: DateTime<Utc>,
    expires: DateTime<Utc>,
    org: &str,
    instance: &str,
    action: &PlannedAction,
) -> Result<String> {
    #[derive(Serialize)]
    struct Signed<'a> {
        version: u8,
        id: Uuid,
        created: DateTime<Utc>,
        expires: DateTime<Utc>,
        org: &'a str,
        instance: &'a str,
        action: &'a PlannedAction,
    }
    let bytes = serde_json::to_vec(&Signed {
        version,
        id,
        created,
        expires,
        org,
        instance,
        action,
    })?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

pub fn content_sha256(content: &str) -> String {
    format!("{:x}", Sha256::digest(content.as_bytes()))
}

pub fn save(root: &Path, plan: &Plan) -> Result<PathBuf> {
    let directory = root.join("plans");
    fs::create_dir_all(&directory)?;
    let path = directory.join(format!("{}.json", plan.id));
    let temporary = directory.join(format!(".{}.tmp", plan.id));
    let contents = serde_json::to_vec(plan)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .context("no se pudo crear el plan protegido")?;
    restrict(&file)?;
    file.write_all(&contents)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&temporary, &path)?;
    Ok(path)
}

pub fn load(root: &Path, id: &str) -> Result<Plan> {
    let id = Uuid::parse_str(id).context("el plan debe ser un UUID")?;
    let path = root.join("plans").join(format!("{id}.json"));
    let metadata = fs::symlink_metadata(&path).map_err(|_| {
        fail(
            Kind::PlanUnavailable,
            format!("no se encontró el plan {id}: nunca se creó aquí o ya se aplicó"),
        )
    })?;
    if metadata.file_type().is_symlink() {
        bail!("no se carga un plan que es un enlace simbólico");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            bail!("no se acepta un plan con permisos para otros usuarios");
        }
    }
    let mut file = File::open(path)?;
    let mut contents = Vec::new();
    file.read_to_end(&mut contents)?;
    serde_json::from_slice(&contents).context("archivo de plan inválido")
}

/// Atomically removes a plan from the runnable directory before a remote
/// mutation. Failures leave it in `inflight/` to prevent unsafe replays.
pub fn claim(root: &Path, id: &str) -> Result<Plan> {
    let id = Uuid::parse_str(id).context("el plan debe ser un UUID")?;
    let source = root.join("plans").join(format!("{id}.json"));
    let destination_dir = root.join("inflight");
    fs::create_dir_all(&destination_dir)?;
    let destination = destination_dir.join(format!("{id}.json"));
    fs::rename(&source, &destination).map_err(|_| {
        fail(
            Kind::PlanUnavailable,
            "el plan no está disponible, ya se usó o no existe",
        )
    })?;
    let metadata = fs::symlink_metadata(&destination)?;
    if metadata.file_type().is_symlink() {
        bail!("refusing symbolic-link plan");
    }
    let mut content = Vec::new();
    File::open(destination)?.read_to_end(&mut content)?;
    let plan: Plan = serde_json::from_slice(&content).context("archivo de plan inválido")?;
    plan.verify()?;
    Ok(plan)
}

pub fn request_body(plan: &Plan) -> Result<Value> {
    match &plan.action {
        PlannedAction::ComposeUpdate {
            compose_id,
            compose_file,
            ..
        } => Ok(json!({"composeId": compose_id, "composeFile": compose_file})),
        PlannedAction::PostgresCreate {
            environment_id,
            name,
            database_name,
            database_user,
            password_env,
            docker_image,
            server_id,
        } => {
            let password = crate::dokploy::config::secret_from_env(password_env)?;
            let mut body = json!({"environmentId": environment_id, "name": name, "databaseName": database_name, "databaseUser": database_user, "databasePassword": password});
            if let Some(image) = docker_image {
                body["dockerImage"] = json!(image);
            }
            if let Some(server) = server_id {
                body["serverId"] = json!(server);
            }
            Ok(body)
        }
        PlannedAction::MongoCreate {
            environment_id,
            server_id,
            name,
            description,
            database_user,
            password_env,
            docker_image,
            ..
        } => {
            let password = crate::dokploy::config::secret_from_env(password_env)?;
            let mut body = json!({
                "environmentId": environment_id, "name": name, "databaseUser": database_user,
                "databasePassword": password, "dockerImage": docker_image
            });
            if let Some(server) = server_id {
                body["serverId"] = json!(server);
            }
            if let Some(description) = description {
                body["description"] = json!(description);
            }
            Ok(body)
        }
        PlannedAction::BackupCreate {
            service_kind,
            service_id,
            database_type,
            database,
            destination_id,
            schedule,
            prefix,
            keep_latest_count,
            ..
        } => Ok(json!({
            service_kind.id_param(): service_id,
            "databaseType": database_type, "database": database,
            "destinationId": destination_id, "schedule": schedule, "prefix": prefix,
            "keepLatestCount": keep_latest_count, "enabled": true, "backupType": "database"
        })),
        PlannedAction::ServiceAction {
            service_kind,
            service_id,
            ..
        } => Ok(json!({ service_kind.id_param(): service_id })),
        PlannedAction::EnvSet {
            service_kind,
            service_id,
            env,
            ..
        } => Ok(json!({ service_kind.id_param(): service_id, "env": env })),
        PlannedAction::MountCreate {
            service_kind,
            service_id,
            mount_type,
            mount_path,
            host_path,
            volume_name,
            file_content,
            ..
        } => {
            let mut body = json!({
                "type": mount_type, "mountPath": mount_path,
                "serviceType": service_kind.mount_service_type(), "serviceId": service_id
            });
            if let Some(host_path) = host_path {
                body["hostPath"] = json!(host_path);
            }
            if let Some(volume_name) = volume_name {
                body["volumeName"] = json!(volume_name);
            }
            if let Some(content) = file_content {
                body["content"] = json!(content);
                // Dokploy stores a file mount under the service's files as `filePath`.
                let name = mount_path.rsplit('/').next().unwrap_or(mount_path);
                body["filePath"] = json!(name);
            }
            Ok(body)
        }
        PlannedAction::ComposeCreate {
            environment_id,
            server_id,
            name,
            description,
            compose_file,
            ..
        } => {
            let mut body = json!({
                "name": name, "environmentId": environment_id,
                "composeType": "docker-compose", "composeFile": compose_file
            });
            if let Some(server) = server_id {
                body["serverId"] = json!(server);
            }
            if let Some(description) = description {
                body["description"] = json!(description);
            }
            Ok(body)
        }
        PlannedAction::ComposeSettings {
            compose_id,
            source_type,
            name,
            description,
            ..
        } => {
            let mut body = json!({"composeId": compose_id});
            if let Some(source_type) = source_type {
                body["sourceType"] = json!(source_type);
            }
            if let Some(name) = name {
                body["name"] = json!(name);
            }
            if let Some(description) = description {
                body["description"] = json!(description);
            }
            Ok(body)
        }
        PlannedAction::RawPost { body, .. } => Ok(body.clone()),
    }
}

pub fn audit_success(root: &Path, plan: &Plan) -> Result<()> {
    audit::append(
        &root.join("audit.jsonl"),
        &audit::AuditEvent {
            timestamp: Utc::now(),
            organization: &plan.organization,
            instance: &plan.instance,
            operation: &plan.action.operation_name(),
            plan_id: &plan.id.to_string(),
            outcome: "applied",
            error: None,
        },
    )
}

pub fn audit_failure(root: &Path, plan: &Plan, error: &str) -> Result<()> {
    audit::append(
        &root.join("audit.jsonl"),
        &audit::AuditEvent {
            timestamp: Utc::now(),
            organization: &plan.organization,
            instance: &plan.instance,
            operation: &plan.action.operation_name(),
            plan_id: &plan.id.to_string(),
            outcome: "failed",
            error: Some(error),
        },
    )
}

#[cfg(unix)]
fn restrict(file: &File) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    file.set_permissions(fs::Permissions::from_mode(0o600))?;
    Ok(())
}
#[cfg(not(unix))]
fn restrict(_: &File) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn plan_rejects_tampering() {
        let mut plan = Plan::new(
            "org".into(),
            "prod".into(),
            PlannedAction::PostgresCreate {
                environment_id: "env".into(),
                name: "db".into(),
                database_name: "db".into(),
                database_user: "user".into(),
                password_env: "DATABASE_PASSWORD".into(),
                docker_image: None,
                server_id: None,
            },
            300,
        )
        .unwrap();
        plan.instance = "other".into();
        assert!(plan.verify().is_err());
    }
    #[test]
    fn env_set_summary_never_contains_values() {
        let plan = Plan::new(
            "org".into(),
            "prod".into(),
            PlannedAction::EnvSet {
                service_kind: ServiceKind::Compose,
                service_id: "c1".into(),
                label: "landing/production/docs".into(),
                env: "SECRET_TOKEN=super-secret-value".into(),
                keys: vec!["SECRET_TOKEN".into()],
                env_sha256: content_sha256("SECRET_TOKEN=super-secret-value"),
                base_env_sha256: content_sha256(""),
                key_changes: None,
                origin: None,
                redeploy: false,
            },
            300,
        )
        .unwrap();
        let shown = plan.safe_output().to_string();
        assert!(shown.contains("SECRET_TOKEN"));
        assert!(!shown.contains("super-secret-value"));
        let body = request_body(&plan).unwrap();
        assert_eq!(body["composeId"], "c1");
        assert_eq!(plan.action.operation_name(), "compose.saveEnvironment");
    }

    #[test]
    fn compose_create_summary_lists_services_not_the_file() {
        let file =
            "services:\n  web:\n    image: nginx\n    environment:\n      TOKEN: hidden-value\n";
        let plan = Plan::new(
            "org".into(),
            "prod".into(),
            PlannedAction::ComposeCreate {
                environment_id: "e1".into(),
                server_id: Some("s1".into()),
                name: "docs".into(),
                description: None,
                compose_file: file.into(),
                content_sha256: content_sha256(file),
            },
            300,
        )
        .unwrap();
        let shown = plan.safe_output().to_string();
        assert!(shown.contains("\"web\""));
        assert!(!shown.contains("hidden-value"));
        assert_eq!(request_body(&plan).unwrap()["serverId"], "s1");
    }

    #[test]
    fn mongo_create_keeps_the_password_out_of_the_plan() {
        let plan = Plan::new(
            "org".into(),
            "prod".into(),
            PlannedAction::MongoCreate {
                environment_id: "e1".into(),
                server_id: Some("s1".into()),
                name: "jobs-db".into(),
                description: None,
                database_user: "jobs".into(),
                password_env: "JOBS_DB_PASSWORD_TEST".into(),
                docker_image: "mongo:8".into(),
                memory_limit_bytes: Some(1_073_741_824),
            },
            300,
        )
        .unwrap();
        assert_eq!(plan.action.operation_name(), "mongo.create");
        // SAFETY: only this test touches this variable.
        unsafe { std::env::set_var("JOBS_DB_PASSWORD_TEST", "hunter2hunter2") };
        let body = request_body(&plan).unwrap();
        assert_eq!(body["databasePassword"], "hunter2hunter2");
        assert_eq!(body["dockerImage"], "mongo:8");
        assert_eq!(body["serverId"], "s1");
        assert!(body.get("memoryLimit").is_none());
        let stored = serde_json::to_string(&plan).unwrap();
        assert!(!stored.contains("hunter2"));
        assert!(!plan.safe_output().to_string().contains("hunter2"));
    }

    #[test]
    fn backup_create_targets_the_database_service() {
        let plan = Plan::new(
            "org".into(),
            "prod".into(),
            PlannedAction::BackupCreate {
                service_kind: ServiceKind::Mongo,
                service_id: "m1".into(),
                label: "shop/production/jobs-db".into(),
                database_type: "mongo".into(),
                database: "jobs".into(),
                destination_id: "d1".into(),
                destination: "s3".into(),
                schedule: "30 3 * * *".into(),
                prefix: "prod/jobs-db/".into(),
                keep_latest_count: 14,
            },
            300,
        )
        .unwrap();
        assert_eq!(plan.action.operation_name(), "backup.create");
        assert_eq!(
            request_body(&plan).unwrap(),
            json!({
                "mongoId": "m1", "databaseType": "mongo", "database": "jobs",
                "destinationId": "d1", "schedule": "30 3 * * *", "prefix": "prod/jobs-db/",
                "keepLatestCount": 14, "enabled": true, "backupType": "database"
            })
        );
    }

    #[test]
    fn service_action_targets_the_right_procedure() {
        let plan = Plan::new(
            "org".into(),
            "prod".into(),
            PlannedAction::ServiceAction {
                service_kind: ServiceKind::Application,
                service_id: "a1".into(),
                label: "Dev/production/core-api".into(),
                action: ServiceAction::Redeploy,
            },
            300,
        )
        .unwrap();
        assert_eq!(plan.action.operation_name(), "application.redeploy");
        assert_eq!(request_body(&plan).unwrap(), json!({"applicationId": "a1"}));
    }

    #[test]
    fn compose_content_is_hashed() {
        assert_ne!(content_sha256("a"), content_sha256("b"));
    }
    #[test]
    fn claiming_a_plan_prevents_replay() {
        let temporary = tempfile::tempdir().unwrap();
        let plan = Plan::new(
            "org".into(),
            "prod".into(),
            PlannedAction::ComposeUpdate {
                compose_id: "compose".into(),
                compose_file: "services: {}".into(),
                content_sha256: content_sha256("services: {}"),
                base_remote_sha256: content_sha256("services: {}"),
                diff: None,
                warnings: Vec::new(),
                redeploy: false,
            },
            300,
        )
        .unwrap();
        save(temporary.path(), &plan).unwrap();
        let claimed = claim(temporary.path(), &plan.id.to_string()).unwrap();
        assert_eq!(claimed.id, plan.id);
        assert!(claim(temporary.path(), &plan.id.to_string()).is_err());
    }
}
