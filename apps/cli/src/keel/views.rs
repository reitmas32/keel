//! Tables for versions, deploys, scopes and status, as the TypeScript CLI
//! printed them.

use crate::keel::api::{CiStatus, Deploy, DeployDetail, DeployStatus, ServiceSummary, Version};
use crate::keel::semver::{compare_desc, is_semver_tag};
use crate::ui::{Colors, Paint, pad_end, width};
use chrono::{DateTime, Datelike, Duration, FixedOffset, Local, NaiveDate, Timelike, Utc};

#[derive(Clone, Copy, Debug)]
pub struct ViewOptions {
    pub now: DateTime<Utc>,
    /// Time zone for dates; the machine's when `None`.
    pub offset: Option<FixedOffset>,
    pub colors: Colors,
}

impl ViewOptions {
    pub fn now(colors: Colors) -> Self {
        Self {
            now: Utc::now(),
            offset: None,
            colors,
        }
    }

    fn local(&self, date: DateTime<Utc>) -> (NaiveDate, u32, u32, u32) {
        match self.offset {
            Some(offset) => {
                let d = date.with_timezone(&offset);
                (d.date_naive(), d.hour(), d.minute(), d.second())
            }
            None => {
                let d = date.with_timezone(&Local);
                (d.date_naive(), d.hour(), d.minute(), d.second())
            }
        }
    }
}

pub struct Header<'a> {
    pub repo: &'a str,
    pub org: &'a str,
    pub api_url: &'a str,
}

pub fn parse_date(iso: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(iso)
        .ok()
        .map(|d| d.with_timezone(&Utc))
}

fn millis_between(from: &str, to: DateTime<Utc>) -> i64 {
    parse_date(from).map_or(0, |f| (to - f).num_milliseconds())
}

fn elapsed(from: &str, to: &str) -> i64 {
    parse_date(to).map_or(0, |t| millis_between(from, t))
}

const MONTHS: [&str; 12] = [
    "ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sept", "oct", "nov", "dic",
];

/// `hoy 14:52`, `ayer 18:40`, `25 oct 10:02`, with the year when it isn't the current one.
pub fn format_when(iso: &str, options: &ViewOptions, with_seconds: bool) -> String {
    let Some(date) = parse_date(iso) else {
        return iso.to_owned();
    };
    let (day, hour, minute, second) = options.local(date);
    let time = if with_seconds {
        format!("{hour:02}:{minute:02}:{second:02}")
    } else {
        format!("{hour:02}:{minute:02}")
    };
    let (today, ..) = options.local(options.now);
    let (yesterday, ..) = options.local(options.now - Duration::days(1));
    if day == today {
        return format!("hoy {time}");
    }
    if day == yesterday {
        return format!("ayer {time}");
    }
    let month = MONTHS[day.month0() as usize];
    if day.year() == today.year() {
        format!("{} {month} {time}", day.day())
    } else {
        format!("{} {month} {} {time}", day.day(), day.year())
    }
}

/// `45s`, `6m 12s`, `2h 05m`.
pub fn format_duration(ms: i64) -> String {
    let seconds = ((ms.max(0) as f64) / 1000.0).round() as i64;
    if seconds < 60 {
        return format!("{seconds}s");
    }
    let minutes = seconds / 60;
    if minutes < 60 {
        return format!("{minutes}m {:02}s", seconds % 60);
    }
    format!("{}h {:02}m", minutes / 60, minutes % 60)
}

pub struct StatusStyle {
    pub icon: &'static str,
    pub label: &'static str,
    pub paint: Paint,
}

pub fn deploy_style(status: DeployStatus) -> StatusStyle {
    let (icon, label, paint) = match status {
        DeployStatus::WaitingCi => ("◌", "esperando CI", Paint::Gray),
        DeployStatus::CiPassed => ("◌", "CI ok, en cola", Paint::Blue),
        DeployStatus::Deploying => ("●", "en curso", Paint::Yellow),
        DeployStatus::Deployed => ("✔", "desplegado", Paint::Green),
        DeployStatus::CiFailed => ("✖", "falló el CI", Paint::Red),
        DeployStatus::DeployFailed => ("✖", "falló el deploy", Paint::Red),
        DeployStatus::Expired => ("◷", "expirado", Paint::Gray),
    };
    StatusStyle { icon, label, paint }
}

pub fn ci_style(status: CiStatus) -> StatusStyle {
    let (icon, label, paint) = match status {
        CiStatus::Pending => ("◌", "CI en curso", Paint::Yellow),
        CiStatus::Success => ("✔", "CI ok", Paint::Green),
        CiStatus::Failure => ("✖", "CI falló", Paint::Red),
        CiStatus::Cancelled => ("✖", "CI cancelado", Paint::Red),
        CiStatus::Expired => ("◷", "sin resultado del CI", Paint::Gray),
    };
    StatusStyle { icon, label, paint }
}

pub fn ci_hint(status: CiStatus) -> &'static str {
    match status {
        CiStatus::Pending => "CI en curso",
        CiStatus::Success => "CI ok",
        CiStatus::Failure => "CI falló",
        CiStatus::Cancelled => "CI cancelado",
        CiStatus::Expired => "sin CI",
    }
}

fn short_id(id: &str) -> &str {
    &id[..id.len().min(8)]
}

fn header_line(header: &Header, c: &Colors) -> String {
    format!(
        "{}  {} · {} · {}",
        c.cyan("◇"),
        c.bold(header.repo),
        header.org,
        c.dim(header.api_url)
    )
}

const INDENT: &str = "  ";
const GAP: &str = "   ";

fn column_widths(titles: &[&str], rows: &[Vec<String>]) -> Vec<usize> {
    titles
        .iter()
        .enumerate()
        .map(|(i, title)| {
            rows.iter()
                .map(|r| r.get(i).map_or(0, |c| width(c)))
                .chain([width(title)])
                .max()
                .unwrap_or(0)
        })
        .collect()
}

fn title_line(titles: &[&str], widths: &[usize], c: &Colors) -> String {
    let text = titles
        .iter()
        .zip(widths)
        .map(|(t, w)| pad_end(t, *w))
        .collect::<Vec<_>>()
        .join(GAP);
    format!("{INDENT}{}", c.dim(&text)).trim_end().to_owned()
}

pub fn render_deploy_list(
    header: &Header,
    deploys: &[Deploy],
    service: Option<&str>,
    options: &ViewOptions,
) -> String {
    let c = &options.colors;
    let mut lines = vec![header_line(header, c), String::new()];
    if deploys.is_empty() {
        lines.push(match service {
            Some(service) => format!("  No hay deploys de {service} todavía."),
            None => "  Todavía no hay deploys. Crea uno con `keel deploy`.".into(),
        });
        return lines.join("\n");
    }
    let rows: Vec<Vec<String>> = deploys
        .iter()
        .map(|d| {
            let end = d.finished();
            let style = deploy_style(d.status);
            vec![
                d.tag.clone(),
                d.service.clone(),
                format!("{} {}", style.icon, style.label),
                format_when(&d.created_at, options, false),
                end.map_or("—".into(), |e| format_when(e, options, false)),
                match end {
                    Some(e) => format_duration(elapsed(&d.created_at, e)),
                    None => format!(
                        "{}…",
                        format_duration(millis_between(&d.created_at, options.now))
                    ),
                },
                short_id(&d.id).to_owned(),
            ]
        })
        .collect();
    let titles = [
        "VERSIÓN",
        "SERVICIO",
        "ESTADO",
        "PEDIDO",
        "TERMINÓ",
        "DURACIÓN",
        "ID",
    ];
    let widths = column_widths(&titles, &rows);
    lines.push(title_line(&titles, &widths, c));
    for (deploy, cells) in deploys.iter().zip(&rows) {
        let style = deploy_style(deploy.status);
        let painted: Vec<String> = cells
            .iter()
            .enumerate()
            .map(|(i, cell)| {
                let padded = pad_end(cell, widths[i]);
                match i {
                    2 => style.paint.apply(c, &padded),
                    6 => c.dim(&padded),
                    _ => padded,
                }
            })
            .collect();
        lines.push(
            format!("{INDENT}{}", painted.join(GAP))
                .trim_end()
                .to_owned(),
        );
        if let Some(error) = deploy
            .error
            .as_deref()
            .filter(|_| deploy.status.is_failure())
        {
            lines.push(format!(
                "{INDENT}{}{GAP}{}",
                " ".repeat(widths[0]),
                c.dim(&format!("└ {error}"))
            ));
        }
    }
    lines.push(String::new());
    lines.push(format!("{INDENT}{}", deploy_summary(deploys, c)));
    lines.join("\n")
}

fn deploy_summary(deploys: &[Deploy], c: &Colors) -> String {
    let count = |statuses: &[DeployStatus]| {
        deploys
            .iter()
            .filter(|d| statuses.contains(&d.status))
            .count()
    };
    let mut parts = vec![format!(
        "{} deploy{}",
        deploys.len(),
        if deploys.len() == 1 { "" } else { "s" }
    )];
    for (n, label) in [
        (count(&[DeployStatus::Deployed]), c.green("✔")),
        (
            count(&[DeployStatus::CiFailed, DeployStatus::DeployFailed]),
            c.red("✖"),
        ),
        (count(&[DeployStatus::Expired]), c.gray("◷")),
        (
            count(&[
                DeployStatus::WaitingCi,
                DeployStatus::CiPassed,
                DeployStatus::Deploying,
            ]),
            "en curso".to_owned(),
        ),
    ] {
        if n > 0 {
            parts.push(format!("{n} {label}"));
        }
    }
    parts.join(" · ")
}

pub fn render_deploy_detail(d: &DeployDetail, options: &ViewOptions) -> String {
    let c = &options.colors;
    let deploy = &d.deploy;
    let style = deploy_style(deploy.status);
    let when = |iso: &str| format_when(iso, options, true);
    let end = deploy.finished();
    let service = match d.service_kind.as_deref() {
        Some("compose") => format!(
            "{}  (Compose, {})",
            deploy.service,
            d.tag_variable.as_deref().unwrap_or("DOCKER_TAG")
        ),
        Some("application") => format!("{}  (Application)", deploy.service),
        _ => deploy.service.clone(),
    };
    let mut fields = vec![
        (
            "Versión",
            format!(
                "{}  (commit {})",
                deploy.tag,
                &deploy.sha[..deploy.sha.len().min(7)]
            ),
        ),
        ("Servicio", service),
        (
            "Estado",
            style
                .paint
                .apply(c, &format!("{} {}", style.icon, style.label)),
        ),
    ];
    if let Some(who) = &deploy.requested_by {
        fields.push(("Pedido por", who.clone()));
    }
    if let Some(error) = &deploy.error {
        fields.push(("Error", error.clone()));
    }
    let mut lines = vec![
        format!(
            "{}  Deploy {} · {}",
            c.cyan("◇"),
            c.bold(short_id(&deploy.id)),
            deploy.repo
        ),
        String::new(),
    ];
    for (label, value) in fields {
        lines.push(format!("  {} {value}", pad_end(label, 11)));
    }
    lines.push(String::new());

    let step =
        |lines: &mut Vec<String>, icon: String, label: &str, at: &str, note: Option<String>| {
            lines.push(format!(
                "  {icon} {} {}{}",
                pad_end(label, 18),
                when(at),
                note.map(|n| c.dim(&format!("   ({n})")))
                    .unwrap_or_default()
            ));
        };
    let pending = |lines: &mut Vec<String>, label: &str, note: String| {
        lines.push(format!(
            "  {} {} {}",
            c.gray("◌"),
            pad_end(label, 18),
            c.dim(&note)
        ));
    };

    step(&mut lines, c.green("✔"), "Pedido", &deploy.created_at, None);
    if let Some(passed) = &deploy.ci_passed_at {
        let waited = elapsed(&deploy.created_at, passed);
        step(
            &mut lines,
            c.green("✔"),
            "CI aprobado",
            passed,
            Some(if waited < 1000 {
                "el CI ya había pasado".into()
            } else {
                format!("{} esperando la Action", format_duration(waited))
            }),
        );
    } else if let (DeployStatus::CiFailed, Some(end)) = (deploy.status, end) {
        step(
            &mut lines,
            c.red("✖"),
            "CI falló",
            end,
            Some(format!(
                "{} esperando la Action",
                format_duration(elapsed(&deploy.created_at, end))
            )),
        );
    } else if let (DeployStatus::Expired, Some(end)) = (deploy.status, end) {
        step(
            &mut lines,
            c.gray("◷"),
            "Expiró sin CI",
            end,
            Some(format!(
                "{} esperando la Action",
                format_duration(elapsed(&deploy.created_at, end))
            )),
        );
    } else if deploy.status == DeployStatus::WaitingCi {
        pending(
            &mut lines,
            "Esperando CI",
            format!(
                "desde hace {}",
                format_duration(millis_between(&deploy.created_at, options.now))
            ),
        );
    }

    if let Some(started) = &deploy.deploy_started_at {
        step(&mut lines, c.green("✔"), "Enviado a Dokploy", started, None);
        if deploy.status == DeployStatus::Deploying {
            lines.push(format!(
                "  {} {} {}",
                c.yellow("●"),
                pad_end("En Dokploy", 18),
                c.dim(&format!(
                    "desde hace {}",
                    format_duration(millis_between(started, options.now))
                ))
            ));
        } else if let Some(end) = end.filter(|_| {
            matches!(
                deploy.status,
                DeployStatus::Deployed | DeployStatus::DeployFailed
            )
        }) {
            let ok = deploy.status == DeployStatus::Deployed;
            step(
                &mut lines,
                if ok { c.green("✔") } else { c.red("✖") },
                "Terminó",
                end,
                Some(format!(
                    "{} en Dokploy",
                    format_duration(elapsed(started, end))
                )),
            );
        }
    } else if deploy.status == DeployStatus::CiPassed {
        pending(
            &mut lines,
            "En cola",
            "esperando su turno para Dokploy".into(),
        );
    }
    lines.join("\n")
}

fn kind_label(s: &ServiceSummary) -> String {
    match s.kind.as_deref() {
        Some("application") => "Application".into(),
        Some("compose") => match s.tag_variable.as_deref() {
            Some(var) if !var.is_empty() && var != "DOCKER_TAG" => format!("Compose ({var})"),
            _ => "Compose".into(),
        },
        _ => "—".into(),
    }
}

/// `✔ hoy 16:04 · 1m 02s` when the last deploy is the current version, else what that last deploy did.
fn last_deploy_cell(s: &ServiceSummary, options: &ViewOptions) -> String {
    let Some(last) = &s.last else {
        return "sin deploys".into();
    };
    let style = deploy_style(last.status);
    if !last.status.is_terminal() {
        return format!(
            "{} {} {} · hace {}",
            style.icon,
            last.tag,
            style.label,
            format_duration(millis_between(&last.created_at, options.now))
        );
    }
    let end = last.finished().unwrap_or(&last.updated_at);
    let when = format_when(end, options, false);
    if s.current.as_ref().is_some_and(|c| c.id == last.id) {
        return format!(
            "{} {when} · {}",
            style.icon,
            format_duration(elapsed(&last.created_at, end))
        );
    }
    format!("{} {} {} · {when}", style.icon, last.tag, style.label)
}

/// `bloqueado por <quién> <cuándo>: <motivo>`.
pub fn lock_text(lock: &crate::keel::api::Lock, options: &ViewOptions) -> String {
    format!(
        "bloqueado por {} {}: {}",
        lock.locked_by.as_deref().unwrap_or("alguien"),
        format_when(&lock.created_at, options, false),
        lock.reason
    )
}

pub fn render_scopes(
    header: &Header,
    services: &[ServiceSummary],
    options: &ViewOptions,
) -> String {
    let c = &options.colors;
    let mut lines = vec![header_line(header, c), String::new()];
    if services.is_empty() {
        lines.push(format!(
            "{INDENT}{} no tiene scopes vinculados. Agrégalos en el admin de keel.",
            header.repo
        ));
        return lines.join("\n");
    }
    if services.iter().all(|s| s.kind.is_none()) {
        lines.push(format!("{INDENT}{}", c.dim("SCOPE")));
        lines.extend(services.iter().map(|s| format!("{INDENT}{}", s.alias)));
        lines.push(String::new());
        lines.push(format!(
            "{INDENT}{} Tu servidor de keel es anterior a v0.5.0: solo muestra los nombres.",
            c.yellow("▲")
        ));
        return lines.join("\n");
    }
    let rows: Vec<Vec<String>> = services
        .iter()
        .map(|s| {
            vec![
                s.alias.clone(),
                s.dokploy_name
                    .clone()
                    .or(s.dokploy_id.clone())
                    .unwrap_or("—".into()),
                kind_label(s),
                s.current.as_ref().map_or("—".into(), |d| d.tag.clone()),
                last_deploy_cell(s, options),
            ]
        })
        .collect();
    let titles = [
        "SCOPE",
        "DOKPLOY",
        "TIPO",
        "VERSIÓN ACTUAL",
        "ÚLTIMO DEPLOY",
    ];
    let widths = column_widths(&titles, &rows);
    lines.push(title_line(&titles, &widths, c));
    for (service, cells) in services.iter().zip(&rows) {
        let painted: Vec<String> = cells
            .iter()
            .enumerate()
            .map(|(i, cell)| {
                let padded = pad_end(cell, widths[i]);
                match (i, &service.last) {
                    (4, Some(last)) => deploy_style(last.status).paint.apply(c, &padded),
                    (1, _) if service.dokploy_name.is_none() => c.dim(&padded),
                    _ => padded,
                }
            })
            .collect();
        lines.push(
            format!("{INDENT}{}", painted.join(GAP))
                .trim_end()
                .to_owned(),
        );
        if let Some(last) = service.last.as_ref().filter(|l| l.status.is_failure())
            && let Some(error) = &last.error
        {
            let offset: usize = widths[..4].iter().map(|w| w + GAP.len()).sum();
            lines.push(format!(
                "{INDENT}{}{}",
                " ".repeat(offset),
                c.dim(&format!("└ {error}"))
            ));
        }
        if let Some(lock) = &service.lock {
            lines.push(format!(
                "{INDENT}{}",
                c.yellow(&format!("└ 🔒 {}", lock_text(lock, options)))
            ));
        }
    }
    lines.push(String::new());
    lines.push(format!(
        "{INDENT}{} {} · despliega con `keel deploy -s <scope> -v <versión>`",
        services.len(),
        if services.len() == 1 {
            "scope"
        } else {
            "scopes"
        }
    ));
    lines.join("\n")
}

/// The highest semver version whose CI passed.
pub fn latest_ready(versions: &[Version]) -> Option<&Version> {
    let mut ready: Vec<&Version> = versions
        .iter()
        .filter(|v| v.ci_status == CiStatus::Success && is_semver_tag(&v.tag))
        .collect();
    ready.sort_by(|a, b| compare_desc(&a.tag, &b.tag));
    ready.first().copied()
}

/// `v1.5.0 · creada por Ana hoy 14:52 desde main · CI en curso`.
pub fn describe_version(v: &Version, options: &ViewOptions) -> String {
    let created = format!(
        "{}{}{}",
        v.author()
            .map_or("creada ".into(), |who| format!("creada por {who} ")),
        format_when(&v.created_at, options, false),
        v.branch
            .as_deref()
            .map_or(String::new(), |b| format!(" desde {b}"))
    );
    format!("{} · {created} · {}", v.tag, ci_style(v.ci_status).label)
}

pub fn render_version_list(header: &Header, versions: &[Version], options: &ViewOptions) -> String {
    let c = &options.colors;
    let mut lines = vec![header_line(header, c), String::new()];
    if versions.is_empty() {
        lines.push(
            "  Todavía no hay versiones registradas. Crea una con `keel create-version`.".into(),
        );
        return lines.join("\n");
    }
    let rows: Vec<Vec<String>> = versions
        .iter()
        .map(|v| {
            let style = ci_style(v.ci_status);
            let ci_time = match (&v.ci_finished_at, v.ci_status) {
                (Some(done), _) => format_duration(elapsed(&v.created_at, done)),
                (None, CiStatus::Pending) => format!(
                    "{}…",
                    format_duration(millis_between(&v.created_at, options.now))
                ),
                _ => "—".into(),
            };
            vec![
                v.tag.clone(),
                v.branch.clone().unwrap_or("—".into()),
                v.author().unwrap_or("—").to_owned(),
                format_when(&v.created_at, options, false),
                format!("{} {}", style.icon, style.label),
                ci_time,
            ]
        })
        .collect();
    let titles = [
        "VERSIÓN",
        "RAMA",
        "CREADA POR",
        "CREADA",
        "CI",
        "DURACIÓN DEL CI",
    ];
    let widths = column_widths(&titles, &rows);
    lines.push(title_line(&titles, &widths, c));
    for (version, cells) in versions.iter().zip(&rows) {
        let style = ci_style(version.ci_status);
        let painted: Vec<String> = cells
            .iter()
            .enumerate()
            .map(|(i, cell)| {
                let padded = pad_end(cell, widths[i]);
                if i == 4 {
                    style.paint.apply(c, &padded)
                } else {
                    padded
                }
            })
            .collect();
        lines.push(
            format!("{INDENT}{}", painted.join(GAP))
                .trim_end()
                .to_owned(),
        );
        if let Some(url) = version
            .run_url
            .as_deref()
            .filter(|_| version.ci_status != CiStatus::Success)
        {
            lines.push(format!(
                "{INDENT}{}{GAP}{}",
                " ".repeat(widths[0]),
                c.dim(&format!("└ {url}"))
            ));
        }
    }
    let ready = latest_ready(versions);
    lines.push(String::new());
    lines.push(format!(
        "{INDENT}{} {}{}",
        versions.len(),
        if versions.len() == 1 {
            "versión"
        } else {
            "versiones"
        },
        match ready {
            Some(v) => format!(" · última lista para desplegar: {}", v.tag),
            None => " · ninguna con el CI en verde".into(),
        }
    ));
    lines.join("\n")
}

/// One scope in `keel status`: keel's view plus what Dokploy says, when it was asked.
pub struct StatusRow<'a> {
    pub service: &'a ServiceSummary,
    /// `running`, `done`, `error`, `idle`… as Dokploy reports the service; `None` without a Dokploy key.
    pub dokploy_status: Option<String>,
}

pub fn render_status(
    header: &Header,
    rows: &[StatusRow],
    versions: Option<&[Version]>,
    in_flight: &[&Deploy],
    dokploy_note: Option<&str>,
    options: &ViewOptions,
) -> String {
    let c = &options.colors;
    let mut lines = vec![header_line(header, c), String::new()];
    if rows.is_empty() {
        lines.push(format!(
            "{INDENT}{} no tiene scopes vinculados. Agrégalos en el admin de keel.",
            header.repo
        ));
    } else {
        let cells: Vec<Vec<String>> = rows
            .iter()
            .map(|r| {
                vec![
                    r.service.alias.clone(),
                    r.service
                        .current
                        .as_ref()
                        .map_or("—".into(), |d| d.tag.clone()),
                    last_deploy_cell(r.service, options),
                    r.dokploy_status.clone().unwrap_or("—".into()),
                ]
            })
            .collect();
        let titles = ["SCOPE", "VERSIÓN", "ÚLTIMO DEPLOY", "DOKPLOY"];
        let widths = column_widths(&titles, &cells);
        lines.push(title_line(&titles, &widths, c));
        for (row, cells) in rows.iter().zip(&cells) {
            let painted: Vec<String> = cells
                .iter()
                .enumerate()
                .map(|(i, cell)| {
                    let padded = pad_end(cell, widths[i]);
                    match i {
                        2 => match &row.service.last {
                            Some(last) => deploy_style(last.status).paint.apply(c, &padded),
                            None => padded,
                        },
                        3 => match row.dokploy_status.as_deref() {
                            Some("running" | "done") => c.green(&padded),
                            Some("error") => c.red(&padded),
                            Some(_) => c.yellow(&padded),
                            None => c.dim(&padded),
                        },
                        _ => padded,
                    }
                })
                .collect();
            lines.push(
                format!("{INDENT}{}", painted.join(GAP))
                    .trim_end()
                    .to_owned(),
            );
        }
    }
    lines.push(String::new());
    match versions {
        Some(versions) => {
            if let Some(newest) = versions.first() {
                let style = ci_style(newest.ci_status);
                lines.push(format!(
                    "{INDENT}última versión: {} · {}",
                    newest.tag,
                    style
                        .paint
                        .apply(c, &format!("{} {}", style.icon, style.label))
                ));
            } else {
                lines.push(format!("{INDENT}todavía no hay versiones"));
            }
            match latest_ready(versions) {
                Some(ready) => lines.push(format!("{INDENT}lista para desplegar: {}", ready.tag)),
                None => lines.push(format!("{INDENT}ninguna versión con el CI en verde")),
            }
        }
        None => lines.push(format!(
            "{INDENT}{} el servidor de keel no registra versiones (anterior a v0.4.0)",
            c.yellow("▲")
        )),
    }
    if in_flight.is_empty() {
        lines.push(format!("{INDENT}sin deploys en curso"));
    } else {
        for d in in_flight {
            let style = deploy_style(d.status);
            lines.push(format!(
                "{INDENT}{} {} → {} · {} · keel deploys {}",
                style.paint.apply(c, style.icon),
                d.tag,
                d.service,
                style.label,
                short_id(&d.id)
            ));
        }
    }
    if let Some(note) = dokploy_note {
        lines.push(format!("{INDENT}{}", c.dim(note)));
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options() -> ViewOptions {
        ViewOptions {
            now: parse_date("2026-10-25T21:30:00Z").unwrap(),
            offset: Some(FixedOffset::west_opt(6 * 3600).unwrap()),
            colors: Colors::plain(),
        }
    }

    fn deploy(id: &str, tag: &str, status: DeployStatus) -> Deploy {
        Deploy {
            id: id.into(),
            repo: "konectus-io/app".into(),
            tag: tag.into(),
            sha: "abcdef0123".into(),
            service: "staging".into(),
            status,
            error: None,
            created_at: "2026-10-25T21:27:00Z".into(),
            updated_at: "2026-10-25T21:27:09Z".into(),
            ci_passed_at: None,
            deploy_started_at: None,
            finished_at: None,
            requested_by: None,
        }
    }

    #[test]
    fn formats_dates_and_durations() {
        let o = options();
        assert_eq!(format_when("2026-10-25T21:27:00Z", &o, false), "hoy 15:27");
        assert_eq!(format_when("2026-10-24T20:00:00Z", &o, false), "ayer 14:00");
        assert_eq!(
            format_when("2026-09-03T16:02:00Z", &o, false),
            "3 sept 10:02"
        );
        assert_eq!(
            format_when("2025-12-31T16:02:00Z", &o, false),
            "31 dic 2025 10:02"
        );
        assert_eq!(format_duration(45_000), "45s");
        assert_eq!(format_duration(372_000), "6m 12s");
        assert_eq!(format_duration(7_500_000), "2h 05m");
    }

    #[test]
    fn deploy_list_shows_errors_and_summary() {
        let mut failed = deploy("06e41709aaaa", "v1.3.1", DeployStatus::DeployFailed);
        failed.error = Some("Dokploy respondió 404".into());
        let mut waiting = deploy("511db4d8bbbb", "v1.5.0", DeployStatus::WaitingCi);
        waiting.updated_at = waiting.created_at.clone();
        let out = render_deploy_list(
            &Header {
                repo: "konectus-io/app",
                org: "github.com:konectus-io",
                api_url: "https://keel/api",
            },
            &[
                waiting,
                deploy("2cf61934cccc", "v1.4.0", DeployStatus::Deployed),
                failed,
            ],
            None,
            &options(),
        );
        assert!(out.contains("v1.5.0    staging    ◌ esperando CI"), "{out}");
        assert!(out.contains("3m 00s…"), "{out}");
        assert!(out.contains("└ Dokploy respondió 404"), "{out}");
        assert!(out.ends_with("3 deploys · 1 ✔ · 1 ✖ · 1 en curso"), "{out}");
    }

    #[test]
    fn latest_ready_is_the_highest_green_version() {
        let version = |tag: &str, ci| Version {
            repo: "r".into(),
            tag: tag.into(),
            sha: "s".into(),
            branch: None,
            created_by_name: None,
            created_by_email: None,
            created_at: "2026-10-25T21:27:00Z".into(),
            ci_status: ci,
            ci_finished_at: None,
            run_url: None,
        };
        let versions = [
            version("v1.10.0", CiStatus::Failure),
            version("v1.9.0", CiStatus::Success),
            version("v1.2.0", CiStatus::Success),
        ];
        assert_eq!(latest_ready(&versions).unwrap().tag, "v1.9.0");
    }
}
