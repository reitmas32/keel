//! End to end: the real `keel` binary against a fake keel server, a fake
//! Dokploy and a local git remote standing in for GitHub.

use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use wiremock::matchers::{method, path, query_param};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

const NULL_DEVICE: &str = if cfg!(windows) { "NUL" } else { "/dev/null" };

struct World {
    _root: tempfile::TempDir,
    home: PathBuf,
    state: PathBuf,
    xdg: PathBuf,
    repo: PathBuf,
    outside: PathBuf,
}

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", NULL_DEVICE)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?}");
}

/// A repo whose origin reads as github.com:acme/app but pushes to a local bare repo.
fn world(keel_url: &str) -> World {
    let root = tempfile::tempdir().unwrap();
    let base = root.path().canonicalize().unwrap();
    let bare = base.join("origin.git");
    let repo = base.join("app");
    let outside = base.join("elsewhere");
    std::fs::create_dir_all(&repo).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    git(
        &base,
        &[
            "init",
            "--quiet",
            "--bare",
            "-b",
            "main",
            bare.to_str().unwrap(),
        ],
    );
    git(&repo, &["init", "--quiet", "-b", "main"]);
    git(&repo, &["config", "user.name", "Ana"]);
    git(&repo, &["config", "user.email", "ana@example.com"]);
    git(&repo, &["config", "commit.gpgsign", "false"]);
    git(&repo, &["config", "tag.gpgsign", "false"]);
    git(
        &repo,
        &["remote", "add", "origin", "git@github.com:acme/app.git"],
    );
    git(
        &repo,
        &[
            "config",
            &format!("url.{}.insteadOf", bare.display()),
            "git@github.com:acme/app.git",
        ],
    );
    std::fs::write(repo.join("README.md"), "app\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "--quiet", "-m", "init"]);
    git(&repo, &["push", "--quiet", "-u", "origin", "main"]);

    let home = base.join("keel-home");
    let org = home.join(if cfg!(windows) {
        "github.com_acme"
    } else {
        "github.com:acme"
    });
    std::fs::create_dir_all(&org).unwrap();
    std::fs::write(
        org.join("config.json"),
        json!({"org": "github.com:acme", "apiUrl": keel_url}).to_string(),
    )
    .unwrap();
    std::fs::write(home.join("current"), "github.com:acme\n").unwrap();
    World {
        state: base.join("state"),
        xdg: base.join("xdg"),
        _root: root,
        home,
        repo,
        outside,
    }
}

impl World {
    fn keel(&self, cwd: &Path, args: &[&str]) -> Output {
        self.keel_env(cwd, args, &[])
    }

    fn keel_env(&self, cwd: &Path, args: &[&str], env: &[(&str, &str)]) -> Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_keel"));
        command
            .args(args)
            .arg("--state-dir")
            .arg(&self.state)
            .current_dir(cwd)
            .env("KEEL_HOME", &self.home)
            .env("XDG_CONFIG_HOME", &self.xdg)
            .env("GIT_CONFIG_GLOBAL", NULL_DEVICE)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("NO_COLOR", "1")
            .env_remove("KEEL_TARGET")
            .env_remove("KEEL_ORG")
            .env_remove("KEEL_CONFIG");
        for (key, value) in env {
            command.env(key, value);
        }
        command.output().unwrap()
    }

    /// A Dokploy instance file for `url`, owner-only as keel requires.
    fn dokploy(&self, url: &str) {
        let dir = self.home.join("dokploy").join("instances");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("acme.env");
        std::fs::write(
            &file,
            format!("DOKPLOY_URL={url}\nDOKPLOY_API_KEY=test-key-123\nDOKPLOY_ALLOW_HTTP=true\nDOKPLOY_DEFAULT=true\n"),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for d in [self.home.join("dokploy"), dir.clone()] {
                std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o700)).unwrap();
            }
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
    }
}

fn json_of(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).unwrap_or_else(|_| {
        panic!(
            "not JSON:\nstdout: {}\nstderr: {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    })
}

fn deploy_json(id: &str, tag: &str, sha: &str, status: &str) -> Value {
    json!({
        "id": id, "repo": "acme/app", "tag": tag, "sha": sha, "service": "stg",
        "status": status, "error": null,
        "createdAt": "2026-11-01T10:00:00Z", "updatedAt": "2026-11-01T10:01:00Z",
        "finishedAt": if status == "deployed" { json!("2026-11-01T10:01:00Z") } else { Value::Null },
    })
}

fn scope_json() -> Value {
    json!({"services": [{
        "alias": "stg", "kind": "compose", "tagVariable": null, "dokployId": "cmp1",
        "dokployName": "Shop/production/web", "current": null, "last": null
    }]})
}

async fn fake_keel() -> MockServer {
    let keel = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/repos/acme/app/services"))
        .respond_with(ResponseTemplate::new(200).set_body_json(scope_json()))
        .mount(&keel)
        .await;
    Mock::given(method("POST"))
        .and(path("/versions"))
        .respond_with(|req: &Request| {
            let body: Value = serde_json::from_slice(&req.body).unwrap();
            ResponseTemplate::new(201).set_body_json(json!({
                "repo": body["repo"], "tag": body["tag"], "sha": body["sha"], "branch": body["branch"],
                "createdByName": body["createdByName"], "createdByEmail": body["createdByEmail"],
                "createdAt": "2026-11-01T10:00:00Z", "ciStatus": "pending", "ciFinishedAt": null, "runUrl": null
            }))
        })
        .mount(&keel)
        .await;
    Mock::given(method("POST"))
        .and(path("/deploys"))
        .respond_with(|req: &Request| {
            let body: Value = serde_json::from_slice(&req.body).unwrap();
            ResponseTemplate::new(201).set_body_json(deploy_json(
                "d00000000001",
                body["tag"].as_str().unwrap(),
                body["sha"].as_str().unwrap(),
                "waiting_ci",
            ))
        })
        .mount(&keel)
        .await;
    keel
}

#[tokio::test]
async fn versions_deploys_and_rollbacks_go_through_keel() {
    let keel = fake_keel().await;
    let w = world(&keel.uri());

    // create-version tags, pushes, registers and deploys that exact version.
    let out = w.keel(
        &w.repo,
        &["create-version", "v1.0.0", "-d", "stg", "--json"],
    );
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
    let created = json_of(&out);
    assert_eq!(created["tag"], "v1.0.0");
    assert_eq!(created["deploy"]["tag"], "v1.0.0");
    let sha = created["sha"].as_str().unwrap().to_owned();
    let requests = keel.received_requests().await.unwrap();
    let register = requests
        .iter()
        .find(|r| r.url.path() == "/versions")
        .unwrap();
    let register: Value = serde_json::from_slice(&register.body).unwrap();
    assert_eq!(register["createdByEmail"], "ana@example.com");
    assert_eq!(register["branch"], "main");

    // The same version again is refused before touching anything.
    let again = w.keel(&w.repo, &["create-version", "v1.0.0", "--json"]);
    assert_eq!(
        again.status.code(),
        Some(27),
        "{}",
        String::from_utf8_lossy(&again.stdout)
    );
    assert_eq!(json_of(&again)["error"]["kind"], "git_state");

    // A typo in the scope does not burn a version number.
    let typo = w.keel(
        &w.repo,
        &["create-version", "v1.0.1", "-d", "prod", "--json"],
    );
    assert_eq!(typo.status.code(), Some(1));
    let tags = Command::new("git")
        .args(["ls-remote", "--tags", "origin"])
        .current_dir(&w.repo)
        .output()
        .unwrap();
    assert!(!String::from_utf8_lossy(&tags.stdout).contains("v1.0.1"));

    // deploy -r picks the highest version whose CI passed.
    Mock::given(method("GET"))
        .and(path("/repos/acme/app/versions"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"versions": [{
                "repo": "acme/app", "tag": "v1.0.0", "sha": sha, "branch": "main",
                "createdByName": "Ana", "createdByEmail": "ana@example.com",
                "createdAt": "2026-11-01T10:00:00Z", "ciStatus": "success",
                "ciFinishedAt": "2026-11-01T10:02:00Z", "runUrl": null
            }]})),
        )
        .mount(&keel)
        .await;
    let out = w.keel(&w.repo, &["deploy", "-r", "-s", "stg", "--json"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
    assert_eq!(json_of(&out)["deploy"]["tag"], "v1.0.0");

    // Without a terminal, missing choices are errors, not prompts.
    let out = w.keel(&w.repo, &["deploy", "-s", "stg"]);
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stdout).contains("Sin terminal interactiva"));

    // rollback goes back to the previous deployed version, with its commit.
    Mock::given(method("GET"))
        .and(path("/repos/acme/app/deploys"))
        .and(query_param("service", "stg"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"deploys": [
            deploy_json("d3", "v1.1.0", "bbbbbbb", "deployed"),
            deploy_json("d2", "v1.0.5", "ccccccc", "deploy_failed"),
            deploy_json("d1", "v1.0.0", &sha, "deployed"),
        ]})))
        .mount(&keel)
        .await;
    let out = w.keel(&w.repo, &["rollback", "-s", "stg", "--json"]);
    assert_eq!(
        out.status.code(),
        Some(1),
        "rollback without -y and without a terminal"
    );
    let out = w.keel(&w.repo, &["rollback", "-s", "stg", "-y", "--json"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
    let rolled = json_of(&out);
    assert_eq!(rolled["to"]["tag"], "v1.0.0");
    assert_eq!(rolled["deploy"]["sha"], sha.as_str());

    // scopes renders a table for people; errors from another org are explicit.
    let out = w.keel(&w.repo, &["scopes"]);
    let table = String::from_utf8_lossy(&out.stdout);
    assert!(
        table.contains("stg") && table.contains("Shop/production/web"),
        "{table}"
    );
    let out = w.keel(&w.repo, &["--org", "github.com:other", "scopes", "--json"]);
    assert_eq!(out.status.code(), Some(2));
}

async fn fake_dokploy() -> MockServer {
    let dokploy = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/project.all"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([{
            "projectId": "p1", "name": "Shop",
            "environments": [{"environmentId": "e1", "name": "production",
                "compose": [{"composeId": "cmp1", "name": "web", "appName": "shop-web-abc", "composeStatus": "done"}]}]
        }])))
        .mount(&dokploy)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/compose.one"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "composeId": "cmp1", "name": "web", "appName": "shop-web-abc", "composeStatus": "done",
            "env": "DOCKER_TAG=v1.0.0\nTOKEN=old-secret-value\n",
            "composeFile": "services:\n  web:\n    image: app:${DOCKER_TAG}\n",
            "sourceType": "raw", "mounts": [], "domains": []
        })))
        .mount(&dokploy)
        .await;
    for procedure in [
        "compose.saveEnvironment",
        "compose.redeploy",
        "compose.deploy",
    ] {
        Mock::given(method("POST"))
            .and(path(format!("/api/{procedure}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!(true)))
            .mount(&dokploy)
            .await;
    }
    dokploy
}

#[tokio::test]
async fn dokploy_plans_respect_keel_scopes() {
    let keel = fake_keel().await;
    let dokploy = fake_dokploy().await;
    let w = world(&keel.uri());
    w.dokploy(&dokploy.uri());

    // A keel scope is deployed with keel, not with a Dokploy plan.
    let out = w.keel(&w.repo, &["plan", "deploy", "Shop/production/web"]);
    assert_eq!(
        out.status.code(),
        Some(25),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
    let error = json_of(&out);
    assert_eq!(error["error"]["kind"], "keel_managed");
    assert!(
        error["error"]["message"]
            .as_str()
            .unwrap()
            .contains("keel deploy -s stg")
    );

    // Nor can an env change move its tag variable.
    let out = w.keel_env(
        &w.repo,
        &["plan", "env-patch", "web", "--set", "DOCKER_TAG"],
        &[("KEEL_SET_DOCKER_TAG", "v9.9.9")],
    );
    assert_eq!(
        out.status.code(),
        Some(25),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );

    // An inherited $TOKEN is never used, and an empty value is refused.
    let out = w.keel_env(
        &w.repo,
        &["plan", "env-patch", "web", "--set", "TOKEN"],
        &[("TOKEN", "inherited")],
    );
    assert_eq!(
        out.status.code(),
        Some(20),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
    assert!(
        json_of(&out)["error"]["message"]
            .as_str()
            .unwrap()
            .contains("empty")
    );

    // Other variables change, with lengths only in the plan, and redeploy in the same plan.
    let out = w.keel_env(
        &w.repo,
        &["plan", "env-patch", "web", "--set", "TOKEN", "--redeploy"],
        &[("KEEL_SET_TOKEN", "brand-new-secret")],
    );
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
    let plan = json_of(&out);
    let shown = plan.to_string();
    assert!(
        !shown.contains("brand-new-secret") && !shown.contains("old-secret-value"),
        "{shown}"
    );
    assert_eq!(plan["changes"]["key_changes"]["changed"][0]["key"], "TOKEN");
    assert_eq!(
        plan["changes"]["key_changes"]["value_sources"]["TOKEN"],
        "env"
    );
    assert_eq!(
        plan["operation"],
        "compose.saveEnvironment+compose.redeploy"
    );
    assert!(plan["keel"].as_str().unwrap().contains("scope stg"));

    // A wrong token never applies; the right one applies once.
    let id = plan["plan_id"].as_str().unwrap().to_owned();
    let token = plan["approval_token_sha256"].as_str().unwrap().to_owned();
    let wrong = w.keel(&w.repo, &["apply", "--plan", &id, "--approve", "nope"]);
    assert_eq!(wrong.status.code(), Some(22));
    let applied = w.keel(&w.repo, &["apply", "--plan", &id, "--approve", &token]);
    assert!(
        applied.status.success(),
        "{}",
        String::from_utf8_lossy(&applied.stdout)
    );
    let applied = json_of(&applied);
    assert_eq!(applied["redeploy"]["ok"], true);
    assert!(applied["previous_env_backup"].as_str().is_some());
    let again = w.keel(&w.repo, &["apply", "--plan", &id, "--approve", &token]);
    assert_eq!(again.status.code(), Some(23));

    let requests = dokploy.received_requests().await.unwrap();
    let saved = requests
        .iter()
        .find(|r| r.url.path() == "/api/compose.saveEnvironment")
        .unwrap();
    let saved: Value = serde_json::from_slice(&saved.body).unwrap();
    assert_eq!(saved["env"], "DOCKER_TAG=v1.0.0\nTOKEN=brand-new-secret\n");
    assert!(
        requests
            .iter()
            .any(|r| r.url.path() == "/api/compose.redeploy")
    );
    assert!(
        requests
            .iter()
            .all(|r| r.headers.get("x-api-key").unwrap() == "test-key-123")
    );

    // The backup is listed and can be restored with a plan.
    let backups = json_of(&w.keel(&w.repo, &["get", "env-backups", "Shop/production/web"]));
    assert_eq!(backups["backups"].as_array().unwrap().len(), 1);

    // Outside a keel repo the Dokploy plan goes ahead, noting keel was not asked.
    let out = w.keel(&w.outside, &["plan", "deploy", "web"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
    assert!(
        json_of(&out)["keel"]
            .as_str()
            .unwrap()
            .contains("no verificado")
    );

    // plan prune removes nothing pending by default.
    let pruned = json_of(&w.keel(&w.outside, &["plan", "prune"]));
    assert_eq!(pruned["pending_kept"], 1);

    // status joins keel's view with what Dokploy says about each scope.
    Mock::given(method("GET"))
        .and(path("/repos/acme/app/versions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"versions": []})))
        .mount(&keel)
        .await;
    Mock::given(method("GET"))
        .and(path("/repos/acme/app/deploys"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"deploys": []})))
        .mount(&keel)
        .await;
    let status = w.keel(&w.repo, &["status", "--json"]);
    assert!(
        status.status.success(),
        "{}",
        String::from_utf8_lossy(&status.stdout)
    );
    let status = json_of(&status);
    assert_eq!(status["scopes"][0]["scope"], "stg");
    assert_eq!(status["scopes"][0]["dokploy_status"], "done");
}

#[tokio::test]
async fn dokploy_needs_a_config_but_keel_commands_do_not() {
    let keel = fake_keel().await;
    let w = world(&keel.uri());
    let out = w.keel(&w.repo, &["get", "services"]);
    assert_eq!(out.status.code(), Some(2));
    assert!(
        json_of(&out)["error"]["message"]
            .as_str()
            .unwrap()
            .contains("instances")
    );
    let out = w.keel(&w.repo, &["scopes", "--json"]);
    assert!(out.status.success());
}
