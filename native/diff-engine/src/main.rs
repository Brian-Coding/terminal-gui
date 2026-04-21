use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{self, Read};
use std::process::Command;

const BRANCH_COLORS: [&str; 8] = [
    "#22c55e", "#3b82f6", "#a855f7", "#ec4899", "#eab308", "#14b8a6", "#f97316", "#ef4444",
];

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
enum DiffLineType {
    Unchanged,
    Added,
    Removed,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DiffLine {
    #[serde(rename = "type")]
    line_type: DiffLineType,
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    old_line_num: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    new_line_num: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiffHunk {
    old_start: usize,
    old_count: usize,
    new_start: usize,
    new_count: usize,
    lines: Vec<DiffLine>,
}

#[derive(Serialize)]
struct DiffStats {
    added: usize,
    removed: usize,
    unchanged: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ParsedDiff {
    hunks: Vec<DiffHunk>,
    old_lines: Vec<DiffLine>,
    new_lines: Vec<DiffLine>,
    stats: DiffStats,
    computed_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitFileEntry {
    status: String,
    staged: bool,
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    original_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitStatusResult {
    cwd: String,
    name: String,
    branch: String,
    upstream: Option<String>,
    ahead: usize,
    behind: usize,
    staged_count: usize,
    unstaged_count: usize,
    untracked_count: usize,
    files: Vec<GitFileEntry>,
}

#[derive(Clone)]
struct GitCommit {
    hash: String,
    message: String,
    author: String,
    author_email: String,
    date: String,
    parents: Vec<String>,
    refs: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GraphCommit {
    hash: String,
    message: String,
    author: String,
    author_email: String,
    author_avatar_url: String,
    date: String,
    parents: Vec<String>,
    refs: Vec<String>,
    column: usize,
    color: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GraphRail {
    column: usize,
    color: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GraphTransition {
    from_column: usize,
    to_column: usize,
    color: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GraphRow {
    row: usize,
    rails: Vec<GraphRail>,
    transitions: Vec<GraphTransition>,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum NativeRequest {
    Diff { before: String, after: String },
    GitStatuses { cwds: Vec<String> },
    GitGraph { cwd: String, limit: usize },
}

#[derive(Serialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum NativeResponse {
    Diff {
        diff: ParsedDiff,
    },
    GitStatuses {
        projects: Vec<GitStatusResult>,
    },
    GitGraph {
        commits: Vec<GraphCommit>,
        rows: Vec<GraphRow>,
    },
}

#[derive(Clone, Copy)]
enum DiffOperation {
    Removed,
    Unchanged,
    Added,
}

fn compute_line_diff(old_text: &str, new_text: &str) -> ParsedDiff {
    let old_lines: Vec<&str> = old_text.split('\n').collect();
    let new_lines: Vec<&str> = new_text.split('\n').collect();
    let m = old_lines.len();
    let n = new_lines.len();
    let mut dp = vec![vec![0u16; n + 1]; m + 1];

    for i in 1..=m {
        for j in 1..=n {
            dp[i][j] = if old_lines[i - 1] == new_lines[j - 1] {
                dp[i - 1][j - 1].saturating_add(1)
            } else {
                dp[i - 1][j].max(dp[i][j - 1])
            };
        }
    }

    let mut diff_ops: Vec<(DiffOperation, Option<usize>, Option<usize>)> = Vec::new();
    let mut i = m;
    let mut j = n;

    while i > 0 || j > 0 {
        if i > 0 && j > 0 && old_lines[i - 1] == new_lines[j - 1] {
            diff_ops.push((DiffOperation::Unchanged, Some(i - 1), Some(j - 1)));
            i -= 1;
            j -= 1;
        } else if j > 0 && (i == 0 || dp[i][j - 1] >= dp[i - 1][j]) {
            diff_ops.push((DiffOperation::Added, None, Some(j - 1)));
            j -= 1;
        } else {
            diff_ops.push((DiffOperation::Removed, Some(i - 1), None));
            i -= 1;
        }
    }

    diff_ops.reverse();

    let mut left_lines = Vec::with_capacity(diff_ops.len());
    let mut right_lines = Vec::with_capacity(diff_ops.len());
    let mut hunks = Vec::new();
    let mut stats = DiffStats {
        added: 0,
        removed: 0,
        unchanged: 0,
    };
    let mut old_line_num = 1usize;
    let mut new_line_num = 1usize;
    let mut current_hunk: Option<DiffHunk> = None;
    let mut unchanged_count = 0usize;
    let context_lines = 3usize;

    for (op, old_idx, new_idx) in diff_ops {
        match op {
            DiffOperation::Unchanged => {
                let line = DiffLine {
                    line_type: DiffLineType::Unchanged,
                    content: old_lines[old_idx.expect("missing old index")].to_string(),
                    old_line_num: Some(old_line_num),
                    new_line_num: Some(new_line_num),
                };
                old_line_num += 1;
                new_line_num += 1;

                left_lines.push(line.clone());
                right_lines.push(line.clone());
                stats.unchanged += 1;

                if let Some(hunk) = current_hunk.as_mut() {
                    unchanged_count += 1;
                    hunk.lines.push(line);
                    if unchanged_count > context_lines * 2 {
                        if let Some(mut complete_hunk) = current_hunk.take() {
                            complete_hunk.old_count = complete_hunk
                                .lines
                                .iter()
                                .filter(|line| !matches!(line.line_type, DiffLineType::Added))
                                .count();
                            complete_hunk.new_count = complete_hunk
                                .lines
                                .iter()
                                .filter(|line| !matches!(line.line_type, DiffLineType::Removed))
                                .count();
                            hunks.push(complete_hunk);
                        }
                        unchanged_count = 0;
                    }
                }
            }
            DiffOperation::Removed => {
                let left_line = DiffLine {
                    line_type: DiffLineType::Removed,
                    content: old_lines[old_idx.expect("missing old index")].to_string(),
                    old_line_num: Some(old_line_num),
                    new_line_num: None,
                };
                old_line_num += 1;

                left_lines.push(left_line.clone());
                right_lines.push(DiffLine {
                    line_type: DiffLineType::Removed,
                    content: String::new(),
                    old_line_num: None,
                    new_line_num: None,
                });
                stats.removed += 1;
                unchanged_count = 0;

                if current_hunk.is_none() {
                    let context_start = left_lines.len().saturating_sub(1 + context_lines);
                    let mut lines = Vec::new();
                    for line in left_lines[context_start..left_lines.len().saturating_sub(1)]
                        .iter()
                        .filter(|line| matches!(line.line_type, DiffLineType::Unchanged))
                    {
                        lines.push(line.clone());
                    }
                    current_hunk = Some(DiffHunk {
                        old_start: left_line.old_line_num.unwrap_or(old_line_num),
                        old_count: 0,
                        new_start: new_line_num,
                        new_count: 0,
                        lines,
                    });
                }

                if let Some(hunk) = current_hunk.as_mut() {
                    hunk.lines.push(left_line);
                }
            }
            DiffOperation::Added => {
                let right_line = DiffLine {
                    line_type: DiffLineType::Added,
                    content: new_lines[new_idx.expect("missing new index")].to_string(),
                    old_line_num: None,
                    new_line_num: Some(new_line_num),
                };
                new_line_num += 1;

                left_lines.push(DiffLine {
                    line_type: DiffLineType::Added,
                    content: String::new(),
                    old_line_num: None,
                    new_line_num: None,
                });
                right_lines.push(right_line.clone());
                stats.added += 1;
                unchanged_count = 0;

                if current_hunk.is_none() {
                    current_hunk = Some(DiffHunk {
                        old_start: old_line_num,
                        old_count: 0,
                        new_start: right_line.new_line_num.unwrap_or(new_line_num),
                        new_count: 0,
                        lines: Vec::new(),
                    });
                }

                if let Some(hunk) = current_hunk.as_mut() {
                    hunk.lines.push(right_line);
                }
            }
        }
    }

    if let Some(mut hunk) = current_hunk {
        if !hunk.lines.is_empty() {
            hunk.old_count = hunk
                .lines
                .iter()
                .filter(|line| !matches!(line.line_type, DiffLineType::Added))
                .count();
            hunk.new_count = hunk
                .lines
                .iter()
                .filter(|line| !matches!(line.line_type, DiffLineType::Removed))
                .count();
            hunks.push(hunk);
        }
    }

    ParsedDiff {
        hunks,
        old_lines: left_lines,
        new_lines: right_lines,
        stats,
        computed_at: 0,
    }
}

fn run_git(args: &[&str], cwd: &str) -> Option<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok()
}

fn parse_git_status(cwd: &str) -> Option<GitStatusResult> {
    run_git(&["rev-parse", "--git-dir"], cwd)?;
    let raw = run_git(
        &["status", "--porcelain=v1", "-b", "--untracked-files=all"],
        cwd,
    )?;

    let mut branch = String::from("HEAD");
    let mut upstream: Option<String> = None;
    let mut ahead = 0usize;
    let mut behind = 0usize;
    let mut files: Vec<GitFileEntry> = Vec::new();

    for line in raw.lines().filter(|line| !line.is_empty()) {
        if let Some(branch_line) = line.strip_prefix("## ") {
            if let Some(dotdot) = branch_line.find("...") {
                branch = branch_line[..dotdot].to_string();
                let rest = &branch_line[dotdot + 3..];
                if let Some(bracket_start) = rest.find('[') {
                    upstream = Some(rest[..bracket_start].trim().to_string());
                    if let Some(bracket_end) = rest.find(']') {
                        let info = &rest[bracket_start + 1..bracket_end];
                        if let Some(value) = info
                            .split(',')
                            .find_map(|part| part.trim().strip_prefix("ahead "))
                        {
                            ahead = value.parse::<usize>().unwrap_or(0);
                        }
                        if let Some(value) = info
                            .split(',')
                            .find_map(|part| part.trim().strip_prefix("behind "))
                        {
                            behind = value.parse::<usize>().unwrap_or(0);
                        }
                    }
                } else if !rest.trim().is_empty() {
                    upstream = Some(rest.trim().to_string());
                }
            } else {
                branch = branch_line
                    .split_whitespace()
                    .next()
                    .unwrap_or("HEAD")
                    .to_string();
            }
            continue;
        }

        let x = line.chars().next().unwrap_or(' ');
        let y = line.chars().nth(1).unwrap_or(' ');
        let file_path = line.get(3..).unwrap_or("").to_string();
        let arrow_idx = file_path.find(" -> ");
        let actual_path = arrow_idx
            .map(|idx| file_path[idx + 4..].to_string())
            .unwrap_or_else(|| file_path.clone());
        let original_path = arrow_idx.map(|idx| file_path[..idx].to_string());

        if x != ' ' && x != '?' {
            files.push(GitFileEntry {
                status: x.to_string(),
                staged: true,
                path: actual_path.clone(),
                original_path: original_path.clone(),
            });
        }

        if y != ' ' && y != '?' {
            files.push(GitFileEntry {
                status: y.to_string(),
                staged: false,
                path: actual_path.clone(),
                original_path: original_path.clone(),
            });
        }

        if x == '?' && y == '?' {
            files.push(GitFileEntry {
                status: String::from("?"),
                staged: false,
                path: actual_path,
                original_path: None,
            });
        }
    }

    let staged_count = files.iter().filter(|file| file.staged).count();
    let unstaged_count = files
        .iter()
        .filter(|file| !file.staged && file.status != "?")
        .count();
    let untracked_count = files.iter().filter(|file| file.status == "?").count();
    let name = cwd.rsplit('/').next().unwrap_or(cwd).to_string();

    Some(GitStatusResult {
        cwd: cwd.to_string(),
        name,
        branch,
        upstream,
        ahead,
        behind,
        staged_count,
        unstaged_count,
        untracked_count,
        files,
    })
}

fn get_graph_log(cwd: &str, limit: usize) -> Vec<GitCommit> {
    let limit_arg = format!("--max-count={}", limit);
    let raw = match run_git(
        &[
            "log",
            &limit_arg,
            "--topo-order",
            "--format=%h\x1f%p\x1f%D\x1f%s\x1f%an\x1f%ae\x1f%ar",
            "--exclude=refs/stash",
            "--all",
        ],
        cwd,
    ) {
        Some(raw) => raw,
        None => return Vec::new(),
    };

    raw.lines()
        .filter(|line| !line.is_empty())
        .map(|line| {
            let mut parts = line.split('\x1f');
            GitCommit {
                hash: parts.next().unwrap_or("").to_string(),
                parents: parts
                    .next()
                    .unwrap_or("")
                    .split(' ')
                    .filter(|part| !part.is_empty())
                    .map(|part| part.to_string())
                    .collect(),
                refs: parts
                    .next()
                    .unwrap_or("")
                    .split(',')
                    .map(|part| part.trim())
                    .filter(|part| !part.is_empty())
                    .map(|part| part.to_string())
                    .collect(),
                message: parts.next().unwrap_or("").to_string(),
                author: parts.next().unwrap_or("").to_string(),
                author_email: parts.next().unwrap_or("").to_string(),
                date: parts.next().unwrap_or("").to_string(),
            }
        })
        .collect()
}

fn gravatar_url(email: &str) -> String {
    let normalized = email.trim().to_lowercase();
    let digest = md5::compute(normalized.as_bytes());
    format!(
        "https://www.gravatar.com/avatar/{:x}?d=identicon&s=32",
        digest
    )
}

#[derive(Clone)]
struct ActiveLane {
    hash: String,
    color: String,
}

fn color_for_hash(
    hash: &str,
    preferred: Option<&str>,
    hash_colors: &mut HashMap<String, String>,
    next_color_index: &mut usize,
) -> String {
    if let Some(existing) = hash_colors.get(hash) {
        return existing.clone();
    }

    let color = preferred.map(ToOwned::to_owned).unwrap_or_else(|| {
        let color = BRANCH_COLORS[*next_color_index % BRANCH_COLORS.len()].to_string();
        *next_color_index += 1;
        color
    });

    hash_colors.insert(hash.to_string(), color.clone());
    color
}

fn layout_graph(commits: &[GitCommit]) -> (Vec<GraphCommit>, Vec<GraphRow>) {
    let mut active_lanes: Vec<ActiveLane> = Vec::new();
    let mut hash_colors = HashMap::<String, String>::new();
    let mut next_color_index = 0usize;
    let mut graph_commits = Vec::with_capacity(commits.len());
    let mut graph_rows = Vec::with_capacity(commits.len());

    for (row_index, commit) in commits.iter().enumerate() {
        let commit_color =
            color_for_hash(&commit.hash, None, &mut hash_colors, &mut next_color_index);

        let commit_column = active_lanes
            .iter()
            .position(|lane| lane.hash == commit.hash)
            .unwrap_or_else(|| {
                active_lanes.push(ActiveLane {
                    hash: commit.hash.clone(),
                    color: commit_color.clone(),
                });
                active_lanes.len() - 1
            });

        if active_lanes[commit_column].color != commit_color {
            active_lanes[commit_column].color = commit_color.clone();
        }

        let rails = active_lanes
            .iter()
            .enumerate()
            .map(|(column, lane)| GraphRail {
                column,
                color: lane.color.clone(),
            })
            .collect::<Vec<_>>();

        graph_commits.push(GraphCommit {
            hash: commit.hash.clone(),
            message: commit.message.clone(),
            author: commit.author.clone(),
            author_email: commit.author_email.clone(),
            author_avatar_url: gravatar_url(&commit.author_email),
            date: commit.date.clone(),
            parents: commit.parents.clone(),
            refs: commit.refs.clone(),
            column: commit_column,
            color: commit_color.clone(),
        });

        let mut next_lanes = active_lanes
            .iter()
            .cloned()
            .map(Some)
            .collect::<Vec<Option<ActiveLane>>>();
        next_lanes[commit_column] = None;
        let mut explicit_transitions: Vec<(String, usize)> = Vec::new();

        if let Some(first_parent) = commit.parents.first() {
            let first_parent_color = color_for_hash(
                first_parent,
                Some(&commit_color),
                &mut hash_colors,
                &mut next_color_index,
            );
            let existing_first_parent_column = next_lanes
                .iter()
                .position(|lane| lane.as_ref().is_some_and(|lane| lane.hash == *first_parent));

            if let Some(existing_column) = existing_first_parent_column {
                if existing_column != commit_column {
                    explicit_transitions.push((first_parent.clone(), commit_column));
                }
            } else {
                next_lanes[commit_column] = Some(ActiveLane {
                    hash: first_parent.clone(),
                    color: first_parent_color,
                });
            }
        }

        for parent in commit.parents.iter().skip(1) {
            if next_lanes
                .iter()
                .any(|lane| lane.as_ref().is_some_and(|lane| lane.hash == *parent))
            {
                continue;
            }

            let parent_color =
                color_for_hash(parent, None, &mut hash_colors, &mut next_color_index);
            let insert_at = (commit_column + 1).min(next_lanes.len());
            next_lanes.insert(
                insert_at,
                Some(ActiveLane {
                    hash: parent.clone(),
                    color: parent_color,
                }),
            );
            explicit_transitions.push((parent.clone(), commit_column));
        }

        let mut next_active_lanes = Vec::with_capacity(next_lanes.len());
        let mut next_positions = HashMap::<String, usize>::new();
        for lane in next_lanes.into_iter().flatten() {
            let next_column = next_active_lanes.len();
            next_positions.insert(lane.hash.clone(), next_column);
            next_active_lanes.push(lane);
        }

        let mut transitions = Vec::new();

        for (column, lane) in active_lanes.iter().enumerate() {
            if let Some(next_column) = next_positions.get(&lane.hash).copied() {
                if next_column != column {
                    transitions.push(GraphTransition {
                        from_column: column,
                        to_column: next_column,
                        color: lane.color.clone(),
                    });
                }
            }
        }

        for (target_hash, from_column) in explicit_transitions {
            if let Some(next_column) = next_positions.get(&target_hash).copied() {
                transitions.push(GraphTransition {
                    from_column,
                    to_column: next_column,
                    color: hash_colors
                        .get(&target_hash)
                        .cloned()
                        .unwrap_or_else(|| commit_color.clone()),
                });
            }
        }

        transitions.sort_by_key(|transition| (transition.from_column, transition.to_column));
        transitions.dedup_by(|a, b| {
            a.from_column == b.from_column && a.to_column == b.to_column && a.color == b.color
        });

        graph_rows.push(GraphRow {
            row: row_index,
            rails,
            transitions,
        });

        active_lanes = next_active_lanes;
    }

    (graph_commits, graph_rows)
}

fn main() {
    let mut input = String::new();
    if io::stdin().read_to_string(&mut input).is_err() {
        eprintln!("failed to read stdin");
        std::process::exit(1);
    }

    let request: NativeRequest = match serde_json::from_str(&input) {
        Ok(request) => request,
        Err(error) => {
            eprintln!("invalid request: {error}");
            std::process::exit(1);
        }
    };

    let response = match request {
        NativeRequest::Diff { before, after } => NativeResponse::Diff {
            diff: compute_line_diff(&before, &after),
        },
        NativeRequest::GitStatuses { cwds } => NativeResponse::GitStatuses {
            projects: cwds
                .iter()
                .filter_map(|cwd| parse_git_status(cwd))
                .collect(),
        },
        NativeRequest::GitGraph { cwd, limit } => {
            let (commits, rows) = layout_graph(&get_graph_log(&cwd, limit));
            NativeResponse::GitGraph { commits, rows }
        }
    };

    match serde_json::to_string(&response) {
        Ok(json) => println!("{json}"),
        Err(error) => {
            eprintln!("failed to serialize response: {error}");
            std::process::exit(1);
        }
    }
}
