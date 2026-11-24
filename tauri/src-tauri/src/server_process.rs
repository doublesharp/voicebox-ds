use std::sync::Mutex;

#[cfg(any(test, windows))]
pub(crate) fn is_windows_server_image(tasklist_csv: &str) -> bool {
    tasklist_csv.lines().any(|line| {
        let image = line
            .split(',')
            .next()
            .unwrap_or("")
            .trim()
            .trim_matches('"');
        matches!(
            image.to_ascii_lowercase().as_str(),
            "voicebox-ds-server.exe" | "voicebox-server-cuda.exe" | "voicebox-server-rocm.exe"
        )
    })
}

#[cfg(any(test, windows))]
pub(crate) fn windows_listener_pid(
    output: &str,
    mut tasklist: impl FnMut(u32) -> Option<String>,
) -> Option<u32> {
    let mut lines = output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty());
    let pid = lines.next()?.parse::<u32>().ok().filter(|pid| *pid > 1)?;
    // A single health response cannot identify an owner when multiple
    // distinct (or malformed) listener records exist.
    if lines.any(|line| line.parse::<u32>().ok() != Some(pid)) {
        return None;
    }
    let rows = tasklist(pid)?;
    let mut saw_row = false;
    for row in rows.lines().filter(|line| !line.trim().is_empty()) {
        saw_row = true;
        let reported_pid = row
            .split(',')
            .nth(1)
            .and_then(|field| field.trim().trim_matches('"').parse::<u32>().ok());
        if reported_pid != Some(pid) || !is_windows_server_image(row) {
            return None;
        }
    }
    saw_row.then_some(pid)
}

#[cfg(unix)]
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ListenerDecision {
    Unoccupied,
    ReuseOwned(u32),
    ReuseExternal,
    Conflict(String),
}

#[cfg(unix)]
fn has_listener_header(output: &str) -> bool {
    let mut fields = output.lines().next().unwrap_or_default().split_whitespace();
    fields.next() == Some("COMMAND") && fields.next() == Some("PID")
}

#[cfg(unix)]
fn listeners(output: &str) -> impl Iterator<Item = (&str, Option<u32>)> {
    output.lines().skip(1).filter_map(|line| {
        let mut fields = line.split_whitespace();
        let name = fields.next()?;
        // Keep incomplete rows as unknown listeners. Dropping one would let a
        // different row establish ownership despite ambiguous discovery output.
        let pid = fields.next().and_then(|value| value.parse::<u32>().ok());
        Some((name, pid))
    })
}

#[cfg(unix)]
pub(crate) fn classify_listener(output: &str, healthy: bool) -> ListenerDecision {
    if !output.trim().is_empty() && !has_listener_header(output) {
        return ListenerDecision::Conflict("unrecognized listener output".into());
    }
    let rows: Vec<_> = listeners(output).collect();
    let Some((name, pid)) = rows.first().copied() else {
        return ListenerDecision::Unoccupied;
    };
    if !healthy {
        return ListenerDecision::Conflict(name.to_string());
    }
    match pid.filter(|pid| *pid > 1) {
        Some(pid)
            if rows
                .iter()
                .all(|(name, row_pid)| {
                    let bundled_name = is_server_name(name)
                        || (cfg!(target_os = "linux") && *name == "voicebox-ds-ser");
                    bundled_name && *row_pid == Some(pid)
                }) =>
        {
            ListenerDecision::ReuseOwned(pid)
        }
        _ => ListenerDecision::ReuseExternal,
    }
}

#[cfg(unix)]
fn is_server_name(name: &str) -> bool {
    // Claim only names produced by the bundled CPU and GPU builds. Similar
    // names can belong to external services and must not be terminated.
    matches!(
        name,
        "voicebox-ds-server" | "voicebox-server" | "voicebox-server-cuda" | "voicebox-server-rocm"
    )
}

#[cfg(any(target_os = "linux", all(test, unix)))]
fn linux_executable_matches(
    pid: u32,
    lookup: impl FnOnce(u32) -> Option<std::path::PathBuf>,
) -> bool {
    lookup(pid)
        .and_then(|path| path.file_name().map(|name| name.to_owned()))
        .and_then(|name| name.to_str().map(is_server_name))
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
pub(crate) fn linux_server_executable(pid: u32) -> bool {
    linux_executable_matches(pid, |pid| {
        std::fs::read_link(format!("/proc/{pid}/exe")).ok()
    })
}

/// Detach a PID and its child together. A stale startup may only detach its
/// own process; an explicit stop may detach whichever process is current.
pub(crate) fn take_process<T>(
    pid: &Mutex<Option<u32>>,
    child: &Mutex<Option<T>>,
    expected: Option<u32>,
) -> Option<(u32, Option<T>)> {
    let mut pid = pid.lock().unwrap();
    let current = (*pid)?;
    if expected.is_some_and(|expected| expected != current) {
        return None;
    }
    let mut child = child.lock().unwrap();
    *pid = None;
    Some((current, child.take()))
}

#[cfg(test)]
mod tests {
    use super::take_process;
    use std::sync::{Arc, Barrier, Mutex};

    #[test]
    fn matching_startup_detaches_both_fields() {
        let pid = Mutex::new(Some(11));
        let child = Mutex::new(Some("original"));
        assert_eq!(
            take_process(&pid, &child, Some(11)),
            Some((11, Some("original")))
        );
        assert_eq!(*pid.lock().unwrap(), None);
        assert_eq!(*child.lock().unwrap(), None);
        assert_eq!(take_process(&pid, &child, Some(11)), None);
    }

    #[test]
    fn stale_cleanup_leaves_a_replacement_intact() {
        let state = Arc::new((Mutex::new(Some(11)), Mutex::new(Some("original"))));
        let replaced = Arc::new(Barrier::new(2));
        let worker_state = Arc::clone(&state);
        let worker_replaced = Arc::clone(&replaced);
        let cleanup = std::thread::spawn(move || {
            worker_replaced.wait();
            take_process(&worker_state.0, &worker_state.1, Some(11))
        });
        {
            let mut pid = state.0.lock().unwrap();
            let mut child = state.1.lock().unwrap();
            *pid = Some(22);
            *child = Some("replacement");
        }
        replaced.wait();
        assert_eq!(cleanup.join().unwrap(), None);
        assert_eq!(*state.0.lock().unwrap(), Some(22));
        assert_eq!(*state.1.lock().unwrap(), Some("replacement"));
        assert_eq!(
            take_process(&state.0, &state.1, None),
            Some((22, Some("replacement")))
        );
    }

    #[test]
    fn windows_tasklist_accepts_only_the_server_executable_names() {
        for image in [
            "voicebox-ds-server.exe",
            "VOICEBOX-SERVER-CUDA.EXE",
            "voicebox-server-rocm.exe",
        ] {
            assert!(super::is_windows_server_image(&format!(
                "\"{image}\",\"123\",\"Console\""
            )));
        }
        for image in [
            "voicebox.exe",
            "voicebox-helper.exe",
            "notvoicebox-server.exe",
            "voicebox-server.exe.bak",
        ] {
            assert!(!super::is_windows_server_image(&format!(
                "\"{image}\",\"123\",\"Console\""
            )));
        }
        assert!(!super::is_windows_server_image(
            "INFO: No tasks are running"
        ));
    }
}

#[cfg(all(test, unix))]
mod listener_tests {
    use super::{classify_listener, ListenerDecision};

    fn lsof(rows: &[(&str, &str)]) -> String {
        let mut output = String::from("COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n");
        for (name, pid) in rows {
            output.push_str(&format!(
                "{name} {pid} user 9u IPv4 1 0t0 TCP localhost:17493 (LISTEN)\n"
            ));
        }
        output
    }

    #[test]
    fn empty_or_malformed_lsof_output_is_unoccupied() {
        assert_eq!(classify_listener("", false), ListenerDecision::Unoccupied);
        assert_eq!(
            classify_listener("COMMAND PID\n\n", false),
            ListenerDecision::Unoccupied
        );
    }

    #[test]
    fn incomplete_listener_rows_prevent_process_ownership() {
        let header = "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n";
        let owned = "voicebox-server 123 user 9u IPv4 1 0t0 TCP localhost:17493 (LISTEN)\n";
        for malformed in ["mystery\n", "voicebox-server\n", "python   \n"] {
            for output in [
                format!("{header}{malformed}{owned}"),
                format!("{header}{owned}{malformed}"),
            ] {
                assert_eq!(
                    classify_listener(&output, true),
                    ListenerDecision::ReuseExternal,
                    "{output:?}"
                );
            }
        }
    }

    #[test]
    fn incomplete_row_without_health_is_a_conflict() {
        assert_eq!(
            classify_listener("COMMAND PID\nunknown\n", false),
            ListenerDecision::Conflict("unknown".into())
        );
    }

    #[test]
    fn blank_lines_do_not_create_ambiguous_listeners() {
        let output = format!("\n{}\n  \n", lsof(&[("voicebox-server", "123")]));
        // lsof emits a header first, followed by blank or listener rows.
        let output = output.trim_start_matches('\n');
        assert_eq!(
            classify_listener(output, true),
            ListenerDecision::ReuseOwned(123)
        );
    }

    #[test]
    fn even_a_voicebox_named_process_must_pass_health_before_reuse() {
        for name in ["voicebox-server", "voicebox-server-cuda"] {
            assert_eq!(
                classify_listener(&lsof(&[(name, "123")]), false),
                ListenerDecision::Conflict(name.into())
            );
            assert_eq!(
                classify_listener(&lsof(&[(name, "123")]), true),
                ListenerDecision::ReuseOwned(123)
            );
        }
    }

    #[test]
    fn unrelated_voicebox_named_program_is_never_owned() {
        for name in [
            "voicebox-",
            "voicebox-helper",
            "myvoicebox",
            "notvoicebox-server",
        ] {
            assert_eq!(
                classify_listener(&lsof(&[(name, "123")]), true),
                ListenerDecision::ReuseExternal
            );
            assert_eq!(
                classify_listener(&lsof(&[(name, "123")]), false),
                ListenerDecision::Conflict(name.into())
            );
        }
    }

    #[test]
    fn healthy_external_server_is_reused_without_claiming_its_process() {
        assert_eq!(
            classify_listener(&lsof(&[("python", "456")]), true),
            ListenerDecision::ReuseExternal
        );
        assert_eq!(
            classify_listener(&lsof(&[("python", "456")]), false),
            ListenerDecision::Conflict("python".into())
        );
    }

    #[test]
    fn invalid_or_system_pids_are_never_claimed() {
        for pid in ["garbage", "-3", "0", "1", "4294967296"] {
            assert_eq!(
                classify_listener(&lsof(&[("voicebox-server", pid)]), true),
                ListenerDecision::ReuseExternal
            );
        }
    }

    #[test]
    fn duplicate_lsof_rows_can_identify_one_owner() {
        let duplicate = lsof(&[("voicebox-server", "123"), ("voicebox-server", "123")]);
        assert_eq!(
            classify_listener(&duplicate, true),
            ListenerDecision::ReuseOwned(123)
        );
        let ambiguous = lsof(&[("voicebox-server", "123"), ("voicebox-server-rocm", "456")]);
        assert_eq!(
            classify_listener(&ambiguous, true),
            ListenerDecision::ReuseExternal
        );
    }
}

#[cfg(all(test, unix))]
mod exact_identity_tests {
    use super::{classify_listener, ListenerDecision};

    fn listener(name: &str, pid: u32) -> String {
        format!("COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n{name} {pid} user 9u IPv4 1 0t0 TCP localhost:8000 (LISTEN)\n")
    }

    #[test]
    fn unrelated_suffixes_are_never_claimed_or_killed() {
        for name in [
            "voicebox-server-helper",
            "voicebox-server-proxy",
            "voicebox-server-malware",
            "voicebox-server-cuda-old",
            "voicebox-server-rocm-debug",
            "voicebox-server-",
            "voicebox-server-cuda.exe",
            "voicebox-server-rocm.exe",
        ] {
            let output = listener(name, 123);
            assert_eq!(
                classify_listener(&output, true),
                ListenerDecision::ReuseExternal,
                "{name}"
            );
        }
    }

    #[test]
    fn exact_bundled_names_are_owned_only_when_health_is_valid() {
        for name in [
            "voicebox-server",
            "voicebox-server-cuda",
            "voicebox-server-rocm",
        ] {
            let output = listener(name, 123);
            assert_eq!(
                classify_listener(&output, true),
                ListenerDecision::ReuseOwned(123)
            );
            assert_eq!(
                classify_listener(&output, false),
                ListenerDecision::Conflict(name.into())
            );
        }
    }

    #[test]
    fn linux_truncated_name_requires_the_real_executable_name() {
        use super::linux_executable_matches;
        use std::path::PathBuf;
        for name in [
            "voicebox-server-helper",
            "voicebox-server-cuda-old",
            "unrelated",
        ] {
            assert!(
                !linux_executable_matches(123, |_| Some(PathBuf::from(format!("/opt/{name}")))),
                "{name}"
            );
        }
        assert!(!linux_executable_matches(123, |_| None));
        for name in [
            "voicebox-server",
            "voicebox-server-cuda",
            "voicebox-server-rocm",
        ] {
            assert!(
                linux_executable_matches(123, |_| Some(PathBuf::from(format!("/opt/{name}")))),
                "{name}"
            );
        }
    }

    #[test]
    fn mixed_exact_and_similar_names_are_not_claimed_even_for_one_pid() {
        let mut output = listener("voicebox-server", 123);
        output.push_str(
            "voicebox-server-helper 123 user 9u IPv4 1 0t0 TCP localhost:8000 (LISTEN)\n",
        );
        assert_eq!(
            classify_listener(&output, true),
            ListenerDecision::ReuseExternal
        );
    }
}

#[cfg(test)]
mod windows_listener_ownership_tests {
    use super::*;
    use std::cell::Cell;

    fn row(name: &str, pid: u32) -> String {
        format!("\"{name}\",\"{pid}\",\"Console\",\"1\",\"10,000 K\"")
    }

    #[test]
    fn multiple_distinct_listeners_are_never_claimed() {
        let calls = Cell::new(0);
        let result = windows_listener_pid("123\n456\n", |pid| {
            calls.set(calls.get() + 1);
            Some(row("voicebox-ds-server.exe", pid))
        });
        assert_eq!(result, None);
        assert_eq!(
            calls.get(),
            0,
            "ambiguous listeners must not be classified by one image"
        );
    }

    #[test]
    fn malformed_or_system_pids_make_ownership_ambiguous() {
        for output in ["123\ninvalid\n", "123\n0\n", "123\n1\n", "123\n-3\n"] {
            assert_eq!(
                windows_listener_pid(output, |pid| Some(row("voicebox-ds-server.exe", pid))),
                None,
                "{output:?}"
            );
        }
    }

    #[test]
    fn tasklist_must_report_the_requested_pid() {
        assert_eq!(
            windows_listener_pid("123\n", |_| Some(row("voicebox-ds-server.exe", 456))),
            None
        );
    }

    #[test]
    fn conflicting_tasklist_rows_are_not_owned() {
        let rows = format!(
            "{}\n{}",
            row("voicebox-ds-server.exe", 123),
            row("unrelated.exe", 123)
        );
        assert_eq!(windows_listener_pid("123\n", |_| Some(rows.clone())), None);
    }

    #[test]
    fn repeated_same_pid_with_exact_image_is_owned_once() {
        let calls = Cell::new(0);
        let result = windows_listener_pid("123\r\n123\r\n", |pid| {
            calls.set(calls.get() + 1);
            Some(row("VOICEBOX-SERVER-CUDA.EXE", pid))
        });
        assert_eq!(result, Some(123));
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn missing_or_unrelated_tasklist_output_remains_external() {
        for rows in [
            None,
            Some("INFO: No tasks are running".into()),
            Some(row("voicebox-server.exe.bak", 123)),
        ] {
            assert_eq!(windows_listener_pid("123", |_| rows.clone()), None);
        }
        assert_eq!(
            windows_listener_pid("", |_| panic!("empty output has no PID")),
            None
        );
    }

    #[test]
    fn all_supported_windows_images_match_only_the_listening_pid() {
        for name in [
            "voicebox-ds-server.exe",
            "voicebox-server-cuda.exe",
            "voicebox-server-rocm.exe",
        ] {
            for pid in [2, 123, u32::MAX] {
                assert_eq!(
                    windows_listener_pid(&format!(" {pid} "), |_| Some(row(name, pid))),
                    Some(pid)
                );
            }
        }
    }

    #[test]
    fn missing_or_malformed_pid_column_is_not_owned() {
        for rows in [
            "\"voicebox-server.exe\"",
            "\"voicebox-server.exe\",\"invalid\"",
            "\"voicebox-server.exe\",\"0\"",
        ] {
            assert_eq!(windows_listener_pid("123", |_| Some(rows.into())), None);
        }
    }

    #[test]
    fn multiple_rows_for_the_same_matching_process_are_allowed() {
        let rows = format!(
            "{}\n{}",
            row("voicebox-ds-server.exe", 123),
            row("VOICEBOX-DS-SERVER.EXE", 123)
        );
        assert_eq!(
            windows_listener_pid("123\n123", |_| Some(rows.clone())),
            Some(123)
        );
    }
}

#[cfg(all(test, unix))]
mod truncated_discovery_tests {
    use super::{classify_listener, ListenerDecision};

    #[test]
    fn headerless_single_listener_is_not_treated_as_an_empty_port() {
        for row in [
            "voicebox-server 123 user 9u IPv4 1 TCP localhost:17493 (LISTEN)\n",
            "python 456 user 9u IPv4 1 TCP localhost:17493 (LISTEN)\n",
        ] {
            assert!(
                matches!(classify_listener(row, false), ListenerDecision::Conflict(_)),
                "{row}"
            );
            assert!(
                matches!(classify_listener(row, true), ListenerDecision::Conflict(_)),
                "{row}"
            );
        }
    }

    #[test]
    fn headerless_mixed_listeners_cannot_claim_or_terminate_the_second_pid() {
        let output = "python 456 user 9u IPv4 1 TCP localhost:17493 (LISTEN)\nvoicebox-server 123 user 9u IPv4 1 TCP localhost:17493 (LISTEN)\n";
        assert!(matches!(
            classify_listener(output, true),
            ListenerDecision::Conflict(_)
        ));
    }

    #[test]
    fn malformed_headers_are_not_assumed_to_be_listener_headers() {
        for output in [
            "unexpected\nvoicebox-server 123 user\n",
            "COMMAND OTHER\nvoicebox-server 123 user\n",
            "\nvoicebox-server 123 user\n",
        ] {
            assert!(
                matches!(
                    classify_listener(output, true),
                    ListenerDecision::Conflict(_)
                ),
                "{output:?}"
            );
        }
    }

    #[test]
    fn normal_header_and_empty_output_remain_supported() {
        assert_eq!(classify_listener("", false), ListenerDecision::Unoccupied);
        assert_eq!(
            classify_listener("COMMAND PID USER\n", false),
            ListenerDecision::Unoccupied
        );
        assert_eq!(
            classify_listener("COMMAND PID USER\nvoicebox-server 123 user\n", true),
            ListenerDecision::ReuseOwned(123)
        );
    }
}
