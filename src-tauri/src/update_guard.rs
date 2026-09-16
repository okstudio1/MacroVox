//! MacroVox — Authenticode pin for updates.
//!
//! Tauri's updater verifies a minisign signature over the downloaded bytes
//! inside `Update::download`. `Update::install` verifies nothing at all and
//! runs whatever bytes it is handed, so a leaked minisign key would be
//! sufficient on its own to ship code to every client.
//!
//! This module is the second, independent gate: before an installer reaches
//! the plugin, its Authenticode signature must be valid, must chain to our
//! certificate, and the version embedded in the file must be the version the
//! update manifest promised. Any doubt fails closed, because refusing an
//! update is recoverable and installing the wrong one is not.
//!
//! Windows only. Elsewhere there is no Authenticode to check and the minisign
//! signature remains the only gate, which is documented in
//! `docs/AUTO_UPDATE.md`.

use log::debug;
#[cfg(not(target_os = "windows"))]
use log::warn;

/// SHA-1 thumbprint of the EV code-signing certificate MacroVox releases are
/// signed with, exactly as `signtool sign /sha1` takes it. This is public
/// information, derivable from any signed artifact, and is pinned here so that
/// a validly-signed installer from anyone else is still rejected.
pub(crate) const EV_CERT_SHA1_THUMBPRINT: &str = "fc22b5221318f3f3f6b3eb2d969d7f99091557bf";

/// Subject common name on that certificate.
pub(crate) const EXPECTED_SIGNER_CN: &str = "OK Studio Inc.";

/// What a signature query reports about an installer.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct SignatureFacts {
    pub status: String,
    pub thumbprint: String,
    pub subject: String,
    pub file_version: String,
}

/// Pulls the common name out of an X.500 subject such as
/// `CN=OK Studio Inc., O=OK Studio Inc., L=..., C=US`.
///
/// Only the first `CN=` is considered, since that is the leaf name.
pub(crate) fn subject_common_name(subject: &str) -> Option<String> {
    subject.split(',').find_map(|part| {
        let part = part.trim();
        let mut chars = part.char_indices();
        let (_, c0) = chars.next()?;
        let (_, c1) = chars.next()?;
        let (eq_idx, c2) = chars.next()?;
        if (c0 == 'C' || c0 == 'c') && (c1 == 'N' || c1 == 'n') && c2 == '=' {
            Some(part[eq_idx + 1..].trim().to_string())
        } else {
            None
        }
    })
}

/// Compares an installer's embedded `FileVersion` against the version the
/// manifest advertised.
///
/// Windows file versions carry four components (`1.0.9.0`) while releases are
/// three-component semver (`1.0.9`), so only the first three are compared.
/// Anything with fewer than three numeric components on either side is
/// rejected rather than guessed at: this check exists to stop a validly signed
/// *older* installer being served as a new version, so a sloppy match defeats
/// the point.
pub(crate) fn file_version_matches(file_version: &str, expected: &str) -> bool {
    fn triple(value: &str) -> Option<[u64; 3]> {
        let mut parts = value.trim().split('.');
        let mut out = [0u64; 3];
        for slot in out.iter_mut() {
            // Take the leading digits of each component so a pre-release like
            // "1.1.0-rc1" still compares as 1.1.0. Refusing a legitimate
            // pre-release update would strand every client on it, which is a
            // worse outcome than comparing only the numeric core. A component
            // with no leading digit is still rejected.
            let digits: String = parts
                .next()?
                .trim()
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            *slot = digits.parse::<u64>().ok()?;
        }
        Some(out)
    }
    match (triple(file_version), triple(expected)) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

/// Applies every pin to one set of reported facts.
pub(crate) fn check_facts(facts: &SignatureFacts, expected_version: &str) -> Result<(), String> {
    if facts.status != "Valid" {
        return Err(format!(
            "Authenticode status is {:?}, expected \"Valid\"",
            facts.status
        ));
    }
    if !facts
        .thumbprint
        .eq_ignore_ascii_case(EV_CERT_SHA1_THUMBPRINT)
    {
        return Err("installer is signed with an unexpected certificate".to_string());
    }
    match subject_common_name(&facts.subject) {
        Some(cn) if cn == EXPECTED_SIGNER_CN => {}
        Some(cn) => return Err(format!("installer signer is {cn:?}")),
        None => return Err("installer signer has no common name".to_string()),
    }
    if !file_version_matches(&facts.file_version, expected_version) {
        return Err(format!(
            "installer reports version {:?} but the update offered {expected_version:?}",
            facts.file_version
        ));
    }
    Ok(())
}

/// Parses the single delimited line the signature query emits.
pub(crate) fn parse_signature_line(line: &str) -> Result<SignatureFacts, String> {
    let fields: Vec<&str> = line.trim().split('|').collect();
    if fields.len() != 4 {
        return Err(format!(
            "signature query returned {} field(s), expected 4",
            fields.len()
        ));
    }
    let facts = SignatureFacts {
        status: fields[0].trim().to_string(),
        thumbprint: fields[1].trim().to_string(),
        subject: fields[2].trim().to_string(),
        file_version: fields[3].trim().to_string(),
    };
    if facts.status.is_empty() || facts.thumbprint.is_empty() {
        return Err("signature query returned no status or thumbprint".to_string());
    }
    Ok(facts)
}

/// Asks Windows what it knows about the file, as one delimited line.
///
/// Kept separate from the checking so the pins can be exercised against
/// crafted output without a signed artifact, and so the only thing that needs
/// a real installer is this function.
#[cfg(target_os = "windows")]
fn query_signature(path: &std::path::Path) -> Result<String, String> {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let path_str = path.to_str().ok_or("installer path is not valid UTF-8")?;
    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    let powershell = format!("{system_root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");

    let script = format!(
        "$ErrorActionPreference='Stop'; \
         $s = Get-AuthenticodeSignature -FilePath '{path_str}'; \
         $v = (Get-Item -LiteralPath '{path_str}').VersionInfo.FileVersion; \
         Write-Output \"$($s.Status)|$($s.SignerCertificate.Thumbprint)|$($s.SignerCertificate.Subject)|$v\""
    );

    let output = std::process::Command::new(&powershell)
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("could not run the signature check: {e}"))?;

    if !output.status.success() {
        return Err(format!(
            "signature check exited with {}",
            output.status.code().unwrap_or(-1)
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "signature check produced no output".to_string())
}

/// The whole gate: guard the path, ask `query` about the file, parse the
/// answer, and apply every pin.
///
/// `query` is what tests replace.
pub(crate) fn verify_with<F>(
    path: &std::path::Path,
    expected_version: &str,
    query: F,
) -> Result<(), String>
where
    F: FnOnce(&std::path::Path) -> Result<String, String>,
{
    let path_str = path.to_str().ok_or("installer path is not valid UTF-8")?;
    // The query embeds the path in a single-quoted PowerShell literal. A quote
    // in the path would break out of it, so refuse rather than escape: this
    // path is one we chose ourselves, so a quote in it means something is
    // wrong, not that we should be clever.
    if path_str.contains('\'') {
        return Err("installer path contains a quote".to_string());
    }

    let line = query(path)?;
    let facts = parse_signature_line(&line)?;
    debug!(
        "[update-guard] installer reports status={} version={}",
        facts.status, facts.file_version
    );
    check_facts(&facts, expected_version)
}

/// Verifies that the installer at `path` is ours and carries `expected_version`.
///
/// Returns `Ok(())` only when every pin holds.
#[cfg(target_os = "windows")]
pub(crate) fn verify_installer(
    path: &std::path::Path,
    expected_version: &str,
) -> Result<(), String> {
    verify_with(path, expected_version, query_signature)
}

/// No Authenticode outside Windows, so the minisign signature stands alone.
#[cfg(not(target_os = "windows"))]
pub(crate) fn verify_installer(
    _path: &std::path::Path,
    _expected_version: &str,
) -> Result<(), String> {
    warn!("[update-guard] no Authenticode check on this platform; minisign only");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn common_name_is_taken_from_a_full_subject() {
        assert_eq!(
            subject_common_name("CN=OK Studio Inc., O=OK Studio Inc., L=Denver, C=US").as_deref(),
            Some("OK Studio Inc.")
        );
        // Order and casing of the attribute key both vary in the wild.
        assert_eq!(
            subject_common_name("O=OK Studio Inc., cn=OK Studio Inc.").as_deref(),
            Some("OK Studio Inc.")
        );
        assert_eq!(subject_common_name("O=Somebody Else, C=US"), None);
        assert_eq!(subject_common_name(""), None);
    }

    #[test]
    fn file_version_compares_the_first_three_components() {
        // Windows pads to four, releases are three.
        assert!(file_version_matches("1.0.9.0", "1.0.9"));
        assert!(file_version_matches("1.0.9", "1.0.9"));
        assert!(!file_version_matches("1.0.8.0", "1.0.9"));
        assert!(!file_version_matches("2.0.9.0", "1.0.9"));
    }

    #[test]
    fn file_version_tolerates_a_pre_release_suffix() {
        // Tauri writes VIAddVersionKey "FileVersion" from the crate version,
        // so a pre-release tag would otherwise refuse its own update.
        assert!(file_version_matches("1.1.0-rc1", "1.1.0"));
        assert!(file_version_matches("1.1.0.0", "1.1.0-rc1"));
        assert!(!file_version_matches("1.1.0-rc1", "1.1.1"));
    }

    #[test]
    fn file_version_refuses_anything_it_cannot_read() {
        // A downgrade attack would love a lenient parser here.
        assert!(!file_version_matches("", "1.0.9"));
        assert!(!file_version_matches("1.0", "1.0.9"));
        assert!(!file_version_matches("1.0.9", "1.0"));
        assert!(!file_version_matches("1.0.x", "1.0.9"));
        assert!(!file_version_matches("not a version", "1.0.9"));
    }

    fn valid_facts() -> SignatureFacts {
        SignatureFacts {
            status: "Valid".to_string(),
            thumbprint: EV_CERT_SHA1_THUMBPRINT.to_uppercase(),
            subject: format!("CN={EXPECTED_SIGNER_CN}, O={EXPECTED_SIGNER_CN}, C=US"),
            file_version: "1.0.9.0".to_string(),
        }
    }

    #[test]
    fn our_own_signed_installer_passes() {
        // Thumbprints come back uppercase from Windows and are pinned
        // lowercase, so the comparison must ignore case.
        assert!(check_facts(&valid_facts(), "1.0.9").is_ok());
    }

    #[test]
    fn an_invalid_signature_is_refused() {
        let mut facts = valid_facts();
        facts.status = "HashMismatch".to_string();
        let err = check_facts(&facts, "1.0.9").unwrap_err();
        assert!(err.contains("HashMismatch"), "{err}");
    }

    #[test]
    fn another_publishers_valid_signature_is_refused() {
        let mut facts = valid_facts();
        facts.thumbprint = "0000000000000000000000000000000000000000".to_string();
        assert!(check_facts(&facts, "1.0.9").is_err());

        let mut facts = valid_facts();
        facts.subject = "CN=Someone Else, C=US".to_string();
        let err = check_facts(&facts, "1.0.9").unwrap_err();
        assert!(err.contains("Someone Else"), "{err}");
    }

    #[test]
    fn a_relabelled_older_installer_is_refused() {
        // The whole reason the version is checked: a genuinely signed 1.0.8
        // installer served as 1.0.9 must not install.
        let mut facts = valid_facts();
        facts.file_version = "1.0.8.0".to_string();
        let err = check_facts(&facts, "1.0.9").unwrap_err();
        assert!(err.contains("1.0.8"), "{err}");
    }

    /// A crafted query response, the way the sibling project fakes its
    /// PowerShell output.
    fn reply(status: &str, thumbprint: &str, cn: &str, file_version: &str) -> String {
        format!("{status}|{thumbprint}|CN={cn}, O={cn}, C=US|{file_version}\n")
    }

    #[test]
    fn the_whole_gate_accepts_our_own_installer() {
        let ok = verify_with(Path::new("C:/tmp/setup.exe"), "1.0.9", |_| {
            Ok(reply(
                "Valid",
                &EV_CERT_SHA1_THUMBPRINT.to_uppercase(),
                EXPECTED_SIGNER_CN,
                "1.0.9.0",
            ))
        });
        assert!(ok.is_ok(), "{ok:?}");
    }

    #[test]
    fn the_whole_gate_refuses_each_broken_pin() {
        let cases: [(&str, String); 4] = [
            (
                "status",
                reply(
                    "NotSigned",
                    &EV_CERT_SHA1_THUMBPRINT.to_uppercase(),
                    EXPECTED_SIGNER_CN,
                    "1.0.9.0",
                ),
            ),
            (
                "thumbprint",
                reply(
                    "Valid",
                    "0000000000000000000000000000000000000000",
                    EXPECTED_SIGNER_CN,
                    "1.0.9.0",
                ),
            ),
            (
                "signer",
                reply(
                    "Valid",
                    &EV_CERT_SHA1_THUMBPRINT.to_uppercase(),
                    "Someone Else",
                    "1.0.9.0",
                ),
            ),
            (
                "version",
                reply(
                    "Valid",
                    &EV_CERT_SHA1_THUMBPRINT.to_uppercase(),
                    EXPECTED_SIGNER_CN,
                    "1.0.8.0",
                ),
            ),
        ];
        for (pin, response) in cases {
            let verdict = verify_with(Path::new("C:/tmp/setup.exe"), "1.0.9", |_| {
                Ok(response.clone())
            });
            assert!(
                verdict.is_err(),
                "the {pin} pin let a bad installer through"
            );
        }
    }

    #[test]
    fn the_gate_refuses_a_quoted_path_without_querying() {
        // A quote would break out of the single-quoted PowerShell literal, so
        // the path is refused before any query runs.
        let mut queried = false;
        let verdict = verify_with(Path::new("C:/tmp/it's here/setup.exe"), "1.0.9", |_| {
            queried = true;
            Ok(reply(
                "Valid",
                &EV_CERT_SHA1_THUMBPRINT.to_uppercase(),
                EXPECTED_SIGNER_CN,
                "1.0.9.0",
            ))
        });
        assert!(verdict.is_err());
        assert!(
            !queried,
            "the query ran on a path that should have been refused"
        );
    }

    #[test]
    fn a_failing_query_refuses_rather_than_installing() {
        let verdict = verify_with(Path::new("C:/tmp/setup.exe"), "1.0.9", |_| {
            Err("powershell is not available".to_string())
        });
        let err = verdict.unwrap_err();
        assert!(err.contains("powershell"), "{err}");
    }

    /// Runs every pin against a real, EV-signed installer. Ignored by default
    /// because it needs an artifact that only the signing host has.
    ///
    /// ```text
    /// $env:MACROVOX_INSTALLER = "path\to\MacroVox_1.0.9_x64-setup.exe"
    /// cargo test --manifest-path src-tauri/Cargo.toml -- --ignored --nocapture real_signed_installer
    /// ```
    ///
    /// This is the one check that cannot be faked, and the one that matters:
    /// the pins ship inside a release but are only exercised when that release
    /// installs the *next* one, so a wrong pin strands every client until they
    /// reinstall by hand. `MACROVOX_INSTALLER_VERSION` overrides the expected
    /// version, which otherwise comes from this crate's own version.
    #[test]
    #[ignore = "needs a signed installer: set MACROVOX_INSTALLER"]
    #[cfg(target_os = "windows")]
    fn a_real_signed_installer_satisfies_every_pin() {
        let installer = std::env::var("MACROVOX_INSTALLER")
            .expect("set MACROVOX_INSTALLER to the signed installer path");
        let expected = std::env::var("MACROVOX_INSTALLER_VERSION")
            .unwrap_or_else(|_| env!("CARGO_PKG_VERSION").to_string());
        let path = Path::new(&installer);
        assert!(path.is_file(), "no installer at {installer}");

        let line =
            query_signature(path).unwrap_or_else(|e| panic!("could not query {installer}: {e}"));
        // Printed first so a failure names the fact that broke the pin.
        println!("query response: {line}");
        let facts = parse_signature_line(&line).expect("the query response should parse");
        println!("{facts:#?}");
        println!("expected version: {expected}");

        check_facts(&facts, &expected).expect("every pin must hold for a real release installer");
    }

    #[test]
    fn signature_line_parses_and_rejects_malformed_output() {
        let facts = parse_signature_line("Valid|ABC123|CN=OK Studio Inc., C=US|1.0.9.0").unwrap();
        assert_eq!(facts.status, "Valid");
        assert_eq!(facts.thumbprint, "ABC123");
        assert_eq!(facts.file_version, "1.0.9.0");

        assert!(parse_signature_line("Valid|ABC123").is_err());
        assert!(parse_signature_line("Valid|ABC123|CN=x|1.0.0|extra").is_err());
        // An unsigned file reports no status and no thumbprint.
        assert!(parse_signature_line("||CN=x|1.0.9.0").is_err());
    }
}
