//! Terminal helpers: colors, interactive prompts and how results are printed.

use crate::failure::{Kind, fail};
use anyhow::Result;
use std::io::IsTerminal;

/// Whether a person is at the terminal: both stdin and stdout are a TTY.
pub fn interactive() -> bool {
    std::io::stdin().is_terminal() && std::io::stdout().is_terminal()
}

/// Colors for stdout, off with NO_COLOR or when stdout is not a terminal.
pub fn stdout_colors() -> Colors {
    Colors::new(std::io::stdout().is_terminal() && std::env::var_os("NO_COLOR").is_none())
}

/// ANSI painter that does nothing when disabled, so views can be tested as plain text.
#[derive(Clone, Copy, Debug)]
pub struct Colors {
    enabled: bool,
}

macro_rules! paint {
    ($($name:ident => $code:expr),* $(,)?) => {
        $(pub fn $name(&self, text: &str) -> String { self.wrap($code, text) })*
    };
}

impl Colors {
    pub fn new(enabled: bool) -> Self {
        Self { enabled }
    }

    pub fn plain() -> Self {
        Self::new(false)
    }

    fn wrap(&self, code: &str, text: &str) -> String {
        if self.enabled {
            format!("\x1b[{code}m{text}\x1b[0m")
        } else {
            text.to_owned()
        }
    }

    paint! {
        bold => "1",
        dim => "2",
        red => "31",
        green => "32",
        yellow => "33",
        blue => "34",
        cyan => "36",
        gray => "90",
    }
}

/// A named color, so status tables can store how a cell is painted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Paint {
    Gray,
    Blue,
    Yellow,
    Green,
    Red,
}

impl Paint {
    pub fn apply(self, c: &Colors, text: &str) -> String {
        match self {
            Self::Gray => c.gray(text),
            Self::Blue => c.blue(text),
            Self::Yellow => c.yellow(text),
            Self::Green => c.green(text),
            Self::Red => c.red(text),
        }
    }
}

/// Visible width of a cell: code points, as the tables only use one-column icons.
pub fn width(text: &str) -> usize {
    text.chars().count()
}

pub fn pad_end(text: &str, width_: usize) -> String {
    let w = width(text);
    if w >= width_ {
        text.to_owned()
    } else {
        format!("{text}{}", " ".repeat(width_ - w))
    }
}

pub fn success(message: &str) {
    println!("{} {message}", stdout_colors().green("✔"));
}

pub fn info(message: &str) {
    println!("{} {message}", stdout_colors().cyan("●"));
}

pub fn warn(message: &str) {
    println!("{} {message}", stdout_colors().yellow("▲"));
}

fn cancelled() -> anyhow::Error {
    fail(Kind::Cancelled, "Cancelado.")
}

/// Asks for a non-empty line of text.
pub fn ask(message: &str, placeholder: &str) -> Result<String> {
    let value: String = dialoguer::Input::new()
        .with_prompt(format!("{message} (p. ej. {placeholder})"))
        .validate_with(|v: &String| -> std::result::Result<(), &str> {
            if v.trim().is_empty() {
                Err("Requerido")
            } else {
                Ok(())
            }
        })
        .interact_text()
        .map_err(|_| cancelled())?;
    Ok(value.trim().to_owned())
}

/// A choice among options shown as `label  (hint)`; returns the index.
pub fn select(
    message: &str,
    options: &[(String, Option<String>)],
    initial: usize,
) -> Result<usize> {
    let items: Vec<String> = options
        .iter()
        .map(|(label, hint)| match hint {
            Some(hint) => format!("{label}  ({hint})"),
            None => label.clone(),
        })
        .collect();
    dialoguer::Select::new()
        .with_prompt(message)
        .items(&items)
        .default(initial.min(items.len().saturating_sub(1)))
        .interact()
        .map_err(|_| cancelled())
}

/// A yes/no question, `no` by default.
pub fn confirm(message: &str) -> Result<bool> {
    dialoguer::Confirm::new()
        .with_prompt(message)
        .default(false)
        .interact()
        .map_err(|_| cancelled())
}

/// A secret typed without echo.
pub fn secret(message: &str) -> Result<String> {
    dialoguer::Password::new()
        .with_prompt(message)
        .interact()
        .map_err(|_| cancelled())
}

/// A secret typed without echo that may be left empty.
pub fn secret_optional(message: &str) -> Result<String> {
    dialoguer::Password::new()
        .with_prompt(message)
        .allow_empty_password(true)
        .interact()
        .map_err(|_| cancelled())
}
