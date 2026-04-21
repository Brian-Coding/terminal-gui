use serde::{Deserialize, Serialize};
use std::io::{self, Read};

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
enum DiffLineType {
    Unchanged,
    Added,
    Removed,
}

#[derive(Serialize)]
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiffRequest {
    before: String,
    after: String,
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
                let content = old_lines[old_idx.expect("missing old index")].to_string();
                let left_line = DiffLine {
                    line_type: DiffLineType::Unchanged,
                    content,
                    old_line_num: Some(old_line_num),
                    new_line_num: Some(new_line_num),
                };
                old_line_num += 1;
                new_line_num += 1;

                left_lines.push(DiffLine {
                    line_type: left_line.line_type,
                    content: left_line.content.clone(),
                    old_line_num: left_line.old_line_num,
                    new_line_num: left_line.new_line_num,
                });
                right_lines.push(DiffLine {
                    line_type: left_line.line_type,
                    content: left_line.content.clone(),
                    old_line_num: left_line.old_line_num,
                    new_line_num: left_line.new_line_num,
                });
                stats.unchanged += 1;

                if let Some(hunk) = current_hunk.as_mut() {
                    unchanged_count += 1;
                    hunk.lines.push(left_line);
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
                let content = old_lines[old_idx.expect("missing old index")].to_string();
                let left_line = DiffLine {
                    line_type: DiffLineType::Removed,
                    content,
                    old_line_num: Some(old_line_num),
                    new_line_num: None,
                };
                let right_line = DiffLine {
                    line_type: DiffLineType::Removed,
                    content: String::new(),
                    old_line_num: None,
                    new_line_num: None,
                };
                old_line_num += 1;

                left_lines.push(DiffLine {
                    line_type: left_line.line_type,
                    content: left_line.content.clone(),
                    old_line_num: left_line.old_line_num,
                    new_line_num: left_line.new_line_num,
                });
                right_lines.push(right_line);
                stats.removed += 1;
                unchanged_count = 0;

                if current_hunk.is_none() {
                    let context_start = left_lines.len().saturating_sub(1 + context_lines);
                    let mut lines = Vec::new();
                    for line in left_lines[context_start..left_lines.len().saturating_sub(1)]
                        .iter()
                        .filter(|line| matches!(line.line_type, DiffLineType::Unchanged))
                    {
                        lines.push(DiffLine {
                            line_type: line.line_type,
                            content: line.content.clone(),
                            old_line_num: line.old_line_num,
                            new_line_num: line.new_line_num,
                        });
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
                let content = new_lines[new_idx.expect("missing new index")].to_string();
                let left_line = DiffLine {
                    line_type: DiffLineType::Added,
                    content: String::new(),
                    old_line_num: None,
                    new_line_num: None,
                };
                let right_line = DiffLine {
                    line_type: DiffLineType::Added,
                    content,
                    old_line_num: None,
                    new_line_num: Some(new_line_num),
                };
                new_line_num += 1;

                left_lines.push(left_line);
                right_lines.push(DiffLine {
                    line_type: right_line.line_type,
                    content: right_line.content.clone(),
                    old_line_num: right_line.old_line_num,
                    new_line_num: right_line.new_line_num,
                });
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

fn main() {
    let mut input = String::new();
    if io::stdin().read_to_string(&mut input).is_err() {
        eprintln!("failed to read stdin");
        std::process::exit(1);
    }

    let request: DiffRequest = match serde_json::from_str(&input) {
        Ok(request) => request,
        Err(error) => {
            eprintln!("invalid request: {error}");
            std::process::exit(1);
        }
    };

    let response = compute_line_diff(&request.before, &request.after);
    match serde_json::to_string(&response) {
        Ok(json) => {
            println!("{json}");
        }
        Err(error) => {
            eprintln!("failed to serialize response: {error}");
            std::process::exit(1);
        }
    }
}

