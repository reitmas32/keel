//! `v`-prefixed semantic versions, as keel tags them.

use regex::Regex;
use std::cmp::Ordering;
use std::sync::LazyLock;

static SEMVER_TAG: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$",
    )
    .unwrap()
});

pub fn is_semver_tag(tag: &str) -> bool {
    SEMVER_TAG.is_match(tag)
}

fn parts(tag: &str) -> Option<(u64, u64, u64, Option<String>)> {
    let c = SEMVER_TAG.captures(tag)?;
    Some((
        c[1].parse().ok()?,
        c[2].parse().ok()?,
        c[3].parse().ok()?,
        c.get(4).map(|m| m.as_str().to_owned()),
    ))
}

/// Compares prerelease identifiers numerically where both are numbers.
fn compare_pre(a: &str, b: &str) -> Ordering {
    let (mut x, mut y) = (a.split('.'), b.split('.'));
    loop {
        match (x.next(), y.next()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(p), Some(q)) => {
                let order = match (p.parse::<u64>(), q.parse::<u64>()) {
                    (Ok(m), Ok(n)) => m.cmp(&n),
                    (Ok(_), Err(_)) => Ordering::Less,
                    (Err(_), Ok(_)) => Ordering::Greater,
                    _ => p.cmp(q),
                };
                if order != Ordering::Equal {
                    return order;
                }
            }
        }
    }
}

/// Orders tags newest first; a prerelease sorts below its release.
pub fn compare_desc(a: &str, b: &str) -> Ordering {
    let (Some(pa), Some(pb)) = (parts(a), parts(b)) else {
        return b.cmp(a);
    };
    let base = (pb.0, pb.1, pb.2).cmp(&(pa.0, pa.1, pa.2));
    if base != Ordering::Equal {
        return base;
    }
    match (&pa.3, &pb.3) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Less,
        (Some(_), None) => Ordering::Greater,
        (Some(x), Some(y)) => compare_pre(y, x),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_tags() {
        assert!(is_semver_tag("v1.4.0"));
        assert!(is_semver_tag("v2.0.0-rc.1"));
        assert!(!is_semver_tag("1.4.0"));
        assert!(!is_semver_tag("v01.0.0"));
        assert!(!is_semver_tag("v1.0"));
    }

    #[test]
    fn sorts_newest_first_with_prereleases_below() {
        let mut tags = vec![
            "v1.0.0",
            "v1.10.0",
            "v1.2.0",
            "v1.10.0-rc.2",
            "v1.10.0-rc.10",
        ];
        tags.sort_by(|a, b| compare_desc(a, b));
        assert_eq!(
            tags,
            [
                "v1.10.0",
                "v1.10.0-rc.10",
                "v1.10.0-rc.2",
                "v1.2.0",
                "v1.0.0"
            ]
        );
    }
}
