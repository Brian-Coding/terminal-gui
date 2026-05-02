import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
	IconArrowLeft,
	IconCheck,
	IconChevronRight,
	IconFolder,
	IconFolderOpen,
	IconGitBranch,
	IconGlobe,
	IconRefreshCw,
	IconTerminal,
	IconUser,
	IconX,
} from "../../components/ui/Icons.tsx";
import { resolveServerUrl } from "../../lib/server-origin.ts";
import { writeStoredValue } from "../../lib/stored-json.ts";
import {
	createGroupId,
	createTerminalPane,
	DEFAULT_COLUMNS,
	DEFAULT_ROWS,
	DEFAULT_FONT_SIZE,
	DEFAULT_FONT_FAMILY,
	DEFAULT_OPACITY,
	loadTerminalState,
	saveTerminalState,
} from "../../lib/terminal-utils.ts";

export const ONBOARDING_DONE_KEY = "inferay-onboarding-done";

/* ─── Types ─── */

interface ForgeAccount {
	provider: "github";
	host: string;
	login: string;
	name: string | null;
	avatarUrl: string | null;
	email: string | null;
	active: boolean;
}

interface GithubRepo {
	name: string;
	full_name: string;
	description: string | null;
	html_url: string;
	language: string | null;
	stargazers_count: number;
	updated_at: string;
	private: boolean;
}

type Step = "intro" | "github" | "projects" | "complete";

const EASING = "cubic-bezier(.22,.82,.2,1)";
const logoUrl = resolveServerUrl("/logo.png");

/* ─── Transition helpers ─── */

function stepClass(
	current: Step,
	target: Step,
	{ active, before, after }: { active: string; before: string; after: string }
) {
	const order: Step[] = ["intro", "github", "projects", "complete"];
	const ci = order.indexOf(current);
	const ti = order.indexOf(target);
	if (ci === ti) return active;
	return ci < ti ? before : after;
}

/* ─── Main component ─── */

export function OnboardingPage() {
	const navigate = useNavigate();
	const [step, setStep] = useState<Step>("intro");

	// GitHub state — fetched eagerly on mount
	const [accounts, setAccounts] = useState<ForgeAccount[]>([]);
	const [accountsLoading, setAccountsLoading] = useState(true);
	const [connecting, setConnecting] = useState(false);

	// Repos state
	const [repos, setRepos] = useState<GithubRepo[]>([]);
	const [reposLoading, setReposLoading] = useState(false);
	const reposFetched = useRef(false);

	// Local folders
	const [localFolders, setLocalFolders] = useState<string[]>([]);
	const [isAddingFolder, setIsAddingFolder] = useState(false);

	// Selected repos
	const [selectedRepos, setSelectedRepos] = useState<Set<string>>(new Set());

	const activeAccount = accounts.find((a) => a.active) ?? accounts[0] ?? null;

	const loadAccounts = useCallback(async () => {
		setAccountsLoading(true);
		try {
			const res = await fetch("/api/forge/accounts");
			if (!res.ok) throw new Error();
			const data = (await res.json()) as { accounts?: ForgeAccount[] };
			const found = Array.isArray(data.accounts) ? data.accounts : [];
			setAccounts(found);
			return found;
		} catch {
			setAccounts([]);
			return [];
		} finally {
			setAccountsLoading(false);
		}
	}, []);

	const loadRepos = useCallback(async () => {
		setReposLoading(true);
		try {
			const res = await fetch("/api/forge/repos?limit=50");
			if (!res.ok) throw new Error();
			const data = (await res.json()) as { repos?: GithubRepo[] };
			setRepos(Array.isArray(data.repos) ? data.repos : []);
		} catch {
			setRepos([]);
		} finally {
			setReposLoading(false);
		}
	}, []);

	// Prefetch on mount
	useEffect(() => {
		loadAccounts().then((found) => {
			if (found.length > 0 && !reposFetched.current) {
				reposFetched.current = true;
				void loadRepos();
			}
		});
	}, [loadAccounts, loadRepos]);

	useEffect(() => {
		if (accounts.length > 0 && !reposFetched.current) {
			reposFetched.current = true;
			void loadRepos();
		}
	}, [accounts, loadRepos]);

	const connectGithub = async () => {
		setConnecting(true);
		try {
			await fetch("/api/forge/connect", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ provider: "github" }),
			});
		} finally {
			setConnecting(false);
		}
	};

	const refreshAccounts = async () => {
		const found = await loadAccounts();
		if (found.length > 0) {
			reposFetched.current = false;
		}
	};

	const pickFolder = async () => {
		if (isAddingFolder) return;
		setIsAddingFolder(true);
		try {
			const res = await fetch("/api/config/pick-folder", { method: "POST" });
			if (!res.ok) return;
			const data = (await res.json()) as { folder: string | null };
			if (data.folder && !localFolders.includes(data.folder)) {
				setLocalFolders((prev) => [...prev, data.folder as string]);
			}
		} catch {
			// ignore
		} finally {
			setIsAddingFolder(false);
		}
	};

	const removeFolder = (folder: string) => {
		setLocalFolders((prev) => prev.filter((f) => f !== folder));
	};

	const toggleRepo = (fullName: string) => {
		setSelectedRepos((prev) => {
			const next = new Set(prev);
			if (next.has(fullName)) next.delete(fullName);
			else next.add(fullName);
			return next;
		});
	};

	const finish = useCallback(() => {
		writeStoredValue(ONBOARDING_DONE_KEY, "true");
		// Default to grid layout
		writeStoredValue("terminal-layout-mode", "grid");
		// Ensure at least 1 terminal pane exists in the default group
		if (!loadTerminalState()) {
			const pane = createTerminalPane("terminal");
			const groupId = createGroupId();
			saveTerminalState({
				groups: [
					{
						id: groupId,
						name: "Default",
						panes: [pane],
						selectedPaneId: pane.id,
						columns: DEFAULT_COLUMNS,
						rows: DEFAULT_ROWS,
					},
				],
				selectedGroupId: groupId,
				themeId: "default",
				fontSize: DEFAULT_FONT_SIZE,
				fontFamily: DEFAULT_FONT_FAMILY,
				opacity: DEFAULT_OPACITY,
			});
		}
		navigate("/terminal", { replace: true });
	}, [navigate]);

	const completeOnboarding = useCallback(() => {
		setStep("complete");
		window.setTimeout(finish, 600);
	}, [finish]);

	return (
		<main className="relative h-full overflow-hidden bg-inferay-black font-sans text-inferay-white antialiased">
			{/* Grid background — like Helmor */}
			<div
				aria-hidden
				className={`pointer-events-none absolute inset-0 transition-opacity duration-700 ${step === "complete" ? "opacity-0" : "opacity-[0.09]"}`}
				style={{
					backgroundImage:
						"linear-gradient(to right, var(--color-inferay-white) 1px, transparent 1px), linear-gradient(to bottom, var(--color-inferay-white) 1px, transparent 1px)",
					backgroundSize: "42px 42px",
					maskImage:
						"radial-gradient(ellipse 82% 68% at 50% 42%, black 15%, transparent 78%)",
					transitionTimingFunction: EASING,
				}}
			/>
			{/* Bottom fade */}
			<div
				aria-hidden
				className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2"
				style={{
					background:
						"linear-gradient(to top, var(--color-inferay-black), transparent)",
				}}
			/>

			{/* All steps rendered simultaneously — CSS transitions only */}
			<IntroStep step={step} onNext={() => setStep("github")} onSkip={finish} />
			<GithubStep
				step={step}
				accounts={accounts}
				loading={accountsLoading}
				connecting={connecting}
				onConnect={connectGithub}
				onRefresh={refreshAccounts}
				onBack={() => setStep("intro")}
				onNext={() => setStep("projects")}
				onSkip={finish}
			/>
			<ProjectsStep
				step={step}
				repos={repos}
				reposLoading={reposLoading}
				hasGithub={accounts.length > 0}
				selected={selectedRepos}
				onToggle={toggleRepo}
				onRefreshRepos={loadRepos}
				localFolders={localFolders}
				isAddingFolder={isAddingFolder}
				onPickFolder={pickFolder}
				onRemoveFolder={removeFolder}
				onBack={() => setStep("github")}
				onComplete={completeOnboarding}
			/>
		</main>
	);
}

/* ─── Step: Intro ─── */

function IntroStep({
	step,
	onNext,
	onSkip,
}: {
	step: Step;
	onNext: () => void;
	onSkip: () => void;
}) {
	const vis = stepClass(step, "intro", {
		active: "translate-x-0 translate-y-0 opacity-100",
		before: "pointer-events-none translate-x-[40vw] opacity-0",
		after: "pointer-events-none -translate-x-[40vw] opacity-0",
	});

	return (
		<section
			aria-hidden={step !== "intro"}
			className={`absolute inset-0 z-10 flex items-center justify-center transition-all duration-700 ${vis}`}
			style={{ transitionTimingFunction: EASING }}
		>
			<div className="flex flex-col items-center text-center">
				<div className="mb-7 flex h-[72px] w-[72px] items-center justify-center overflow-hidden rounded-2xl border border-inferay-gray-border bg-inferay-dark-gray shadow-2xl shadow-black/40">
					<img
						src={logoUrl}
						alt=""
						draggable={false}
						className="h-[72px] w-[72px] rounded-2xl object-cover"
					/>
				</div>
				<h1 className="text-[28px] font-semibold leading-tight tracking-tight text-inferay-white">
					Welcome to Inferay
				</h1>
				<p className="mt-4 max-w-md text-[13px] font-medium leading-6 text-inferay-muted-gray">
					Multi-agent terminal workbench. Connect your GitHub, bring in your
					projects, and start building.
				</p>

				<div className="mt-8 flex items-center gap-3">
					<button
						type="button"
						onClick={onNext}
						className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-inferay-white px-5 text-[13px] font-medium text-inferay-black transition-all hover:opacity-85 active:scale-[0.97]"
					>
						Get started
						<IconChevronRight size={16} />
					</button>
				</div>
				<button
					type="button"
					onClick={onSkip}
					className="mt-5 text-[11px] text-inferay-muted-gray transition-colors hover:text-inferay-soft-white"
				>
					Skip setup
				</button>
			</div>
		</section>
	);
}

/* ─── Step: GitHub ─── */

function GithubStep({
	step,
	accounts,
	loading,
	connecting,
	onConnect,
	onRefresh,
	onBack,
	onNext,
	onSkip,
}: {
	step: Step;
	accounts: ForgeAccount[];
	loading: boolean;
	connecting: boolean;
	onConnect: () => void;
	onRefresh: () => void;
	onBack: () => void;
	onNext: () => void;
	onSkip: () => void;
}) {
	const vis = stepClass(step, "github", {
		active: "translate-x-0 translate-y-0 opacity-100",
		before:
			"pointer-events-none translate-x-[40vw] translate-y-[8vh] opacity-0 blur-sm",
		after:
			"pointer-events-none -translate-x-[40vw] translate-y-[8vh] opacity-0 blur-sm",
	});

	return (
		<section
			aria-hidden={step !== "github"}
			className={`absolute inset-0 z-10 flex items-center justify-center transition-all duration-700 ${vis}`}
			style={{ transitionTimingFunction: EASING }}
		>
			<div className="flex w-[520px] max-w-full flex-col px-6">
				<div className="text-center">
					<h2 className="text-[24px] font-semibold tracking-tight text-inferay-white">
						Connect GitHub
					</h2>
					<p className="mx-auto mt-3 max-w-md text-[12px] leading-6 text-inferay-muted-gray">
						Inferay detects accounts from the GitHub CLI. If you already have{" "}
						<span className="font-mono text-inferay-soft-white">gh</span>{" "}
						authenticated, your account appears automatically.
					</p>
				</div>

				<div className="mt-7">
					{loading ? (
						<div className="flex h-20 items-center justify-center text-[12px] text-inferay-muted-gray">
							<IconRefreshCw size={15} className="mr-2.5 animate-spin" />
							Checking gh auth status...
						</div>
					) : accounts.length > 0 ? (
						<div className="space-y-2">
							{accounts.map((account) => (
								<div
									key={`${account.host}:${account.login}`}
									className="flex items-center gap-3 rounded-lg border border-inferay-gray-border bg-inferay-dark-gray p-3"
								>
									<div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full border border-inferay-gray-border bg-inferay-gray">
										{account.avatarUrl ? (
											<img
												src={account.avatarUrl}
												alt={account.login}
												className="h-full w-full object-cover"
											/>
										) : (
											<IconUser size={18} className="text-inferay-muted-gray" />
										)}
									</div>
									<div className="min-w-0 flex-1">
										<p className="truncate text-[13px] font-medium text-inferay-white">
											{account.name || account.login}
										</p>
										<p className="truncate text-[11px] text-inferay-muted-gray">
											@{account.login} · {account.host}
										</p>
									</div>
								</div>
							))}
						</div>
					) : (
						<div className="rounded-lg border border-inferay-gray-border bg-inferay-dark-gray p-5 text-center">
							<div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-lg border border-inferay-gray-border bg-inferay-black text-inferay-muted-gray">
								<IconGitBranch size={20} />
							</div>
							<p className="text-[12px] font-medium text-inferay-white">
								No GitHub accounts detected
							</p>
							<p className="mt-1 text-[11px] text-inferay-muted-gray">
								Run the GitHub CLI login to connect your account.
							</p>
							<div className="mt-4 flex items-center justify-center gap-2">
								<button
									type="button"
									onClick={onConnect}
									disabled={connecting}
									className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-inferay-gray border border-inferay-gray-border px-4 text-[12px] font-medium text-inferay-soft-white transition-all hover:bg-inferay-light-gray disabled:opacity-40 disabled:pointer-events-none active:scale-[0.97]"
								>
									<IconTerminal size={14} />
									{connecting ? "Opening terminal..." : "Run gh auth login"}
								</button>
								<button
									type="button"
									onClick={onRefresh}
									disabled={loading}
									className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg px-3 text-[12px] text-inferay-muted-gray transition-all hover:text-inferay-white hover:bg-inferay-white/[0.08] disabled:opacity-40"
								>
									<IconRefreshCw size={13} />
									Refresh
								</button>
							</div>
						</div>
					)}
				</div>

				<div className="mt-7 flex items-center justify-center gap-3">
					<button
						type="button"
						onClick={onBack}
						className="inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-[13px] text-inferay-muted-gray transition-all hover:text-inferay-white hover:bg-inferay-white/[0.08] active:scale-[0.97]"
					>
						<IconArrowLeft size={16} />
						Back
					</button>
					<button
						type="button"
						onClick={onNext}
						className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-inferay-white px-5 text-[13px] font-medium text-inferay-black transition-all hover:opacity-85 active:scale-[0.97]"
					>
						{accounts.length > 0 ? "Continue" : "Skip"}
						<IconChevronRight size={16} />
					</button>
				</div>
			</div>
		</section>
	);
}

/* ─── Step: Projects ─── */

function ProjectsStep({
	step,
	repos,
	reposLoading,
	hasGithub,
	selected,
	onToggle,
	onRefreshRepos,
	localFolders,
	isAddingFolder,
	onPickFolder,
	onRemoveFolder,
	onBack,
	onComplete,
}: {
	step: Step;
	repos: GithubRepo[];
	reposLoading: boolean;
	hasGithub: boolean;
	selected: Set<string>;
	onToggle: (fullName: string) => void;
	onRefreshRepos: () => void;
	localFolders: string[];
	isAddingFolder: boolean;
	onPickFolder: () => void;
	onRemoveFolder: (folder: string) => void;
	onBack: () => void;
	onComplete: () => void;
}) {
	const totalProjects = selected.size + localFolders.length;

	const vis = stepClass(step, "projects", {
		active: "translate-x-0 translate-y-0 opacity-100",
		before:
			"pointer-events-none translate-x-[40vw] translate-y-[8vh] opacity-0 blur-sm",
		after:
			"pointer-events-none -translate-x-[18vw] -translate-y-[16vh] scale-[1.08] opacity-0 blur-sm",
	});

	return (
		<section
			aria-hidden={step !== "projects"}
			className={`absolute inset-0 z-10 flex items-center justify-center transition-all duration-1000 ${vis}`}
			style={{ transitionTimingFunction: EASING }}
		>
			<div className="flex w-[540px] max-w-full flex-col px-6">
				<div className="text-center">
					<h2 className="text-[24px] font-semibold tracking-tight text-inferay-white">
						Bring in your projects
					</h2>
					<p className="mx-auto mt-3 max-w-md text-[12px] leading-6 text-inferay-muted-gray">
						Start with a local folder or select repositories from GitHub. You
						can add more anytime.
					</p>
				</div>

				{/* Action cards — Helmor style */}
				<div className="mt-7 grid grid-cols-2 gap-3">
					<button
						type="button"
						onClick={onPickFolder}
						disabled={isAddingFolder}
						className="flex cursor-pointer flex-col items-start rounded-lg border border-inferay-gray-border bg-inferay-dark-gray p-4 text-left transition-colors hover:bg-inferay-gray disabled:cursor-default disabled:opacity-70"
					>
						<div className="flex h-10 w-10 items-center justify-center rounded-lg border border-inferay-gray-border bg-inferay-black text-inferay-soft-white">
							<IconFolderOpen size={20} />
						</div>
						<div className="mt-4 text-[13px] font-medium text-inferay-white">
							Choose local project
						</div>
						<p className="mt-1 text-[11px] leading-5 text-inferay-muted-gray">
							Add a folder already on this machine.
						</p>
					</button>
					<button
						type="button"
						onClick={hasGithub ? onRefreshRepos : undefined}
						disabled={!hasGithub || reposLoading}
						className="flex cursor-pointer flex-col items-start rounded-lg border border-inferay-gray-border bg-inferay-dark-gray p-4 text-left transition-colors hover:bg-inferay-gray disabled:cursor-default disabled:opacity-70"
					>
						<div className="flex h-10 w-10 items-center justify-center rounded-lg border border-inferay-gray-border bg-inferay-black text-inferay-soft-white">
							<IconGlobe size={20} />
						</div>
						<div className="mt-4 text-[13px] font-medium text-inferay-white">
							Import from GitHub
						</div>
						<p className="mt-1 text-[11px] leading-5 text-inferay-muted-gray">
							{hasGithub
								? "Select from your repositories below."
								: "Connect GitHub first to browse repos."}
						</p>
					</button>
				</div>

				{/* Added projects list */}
				<div className="mt-6 min-h-0 flex-1">
					<div className="mb-2 flex items-center justify-between text-[11px] text-inferay-muted-gray">
						<span>
							{hasGithub && repos.length > 0
								? "Your repositories"
								: localFolders.length > 0
									? "Added projects"
									: "Projects"}
						</span>
						{totalProjects > 0 && <span>{totalProjects}</span>}
					</div>
					<div className="max-h-[240px] overflow-y-auto rounded-lg border border-inferay-gray-border bg-inferay-dark-gray scrollbar-none">
						{/* Local folders */}
						{localFolders.map((folder) => (
							<div
								key={folder}
								className="flex h-10 items-center gap-2 border-b border-inferay-gray-border px-3 last:border-b-0"
							>
								<IconFolder
									size={14}
									className="shrink-0 text-inferay-muted-gray"
								/>
								<div className="min-w-0 flex-1">
									<p className="truncate text-[11px] font-medium text-inferay-white">
										{folder}
									</p>
								</div>
								<button
									type="button"
									onClick={() => onRemoveFolder(folder)}
									className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-inferay-muted-gray transition-colors hover:bg-inferay-error/10 hover:text-inferay-error"
								>
									<IconX size={14} />
								</button>
							</div>
						))}

						{/* GitHub repos */}
						{hasGithub && reposLoading ? (
							<div className="flex h-20 items-center justify-center text-[11px] text-inferay-muted-gray">
								<IconRefreshCw size={13} className="mr-2 animate-spin" />
								Loading repositories...
							</div>
						) : hasGithub && repos.length > 0 ? (
							repos.map((repo) => {
								const isSelected = selected.has(repo.full_name);
								return (
									<button
										type="button"
										key={repo.full_name}
										onClick={() => onToggle(repo.full_name)}
										className={`flex w-full items-center gap-2.5 border-b border-inferay-gray-border px-3 py-2 text-left transition-colors last:border-b-0 ${
											isSelected
												? "bg-inferay-white/[0.05]"
												: "hover:bg-inferay-gray/50"
										}`}
									>
										<div
											className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
												isSelected
													? "border-inferay-white bg-inferay-white text-inferay-black"
													: "border-inferay-gray-border bg-inferay-black"
											}`}
										>
											{isSelected && <IconCheck size={10} />}
										</div>
										<div className="min-w-0 flex-1">
											<p className="truncate text-[11px] font-medium text-inferay-white">
												{repo.full_name}
											</p>
											{repo.description && (
												<p className="truncate text-[10px] text-inferay-muted-gray">
													{repo.description}
												</p>
											)}
										</div>
										<div className="flex shrink-0 items-center gap-2">
											{repo.language && (
												<span className="text-[10px] text-inferay-muted-gray">
													{repo.language}
												</span>
											)}
											{repo.private && (
												<span className="rounded bg-inferay-gray px-1 py-0.5 text-[9px] text-inferay-muted-gray">
													private
												</span>
											)}
										</div>
									</button>
								);
							})
						) : localFolders.length === 0 ? (
							<div className="flex h-28 items-center justify-center text-center text-[11px] leading-5 text-inferay-muted-gray">
								Choose a local folder or select GitHub repos
								<br />
								to get started.
							</div>
						) : null}
					</div>
				</div>

				<div className="mt-7 flex items-center justify-center gap-3">
					<button
						type="button"
						onClick={onBack}
						className="inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-[13px] text-inferay-muted-gray transition-all hover:text-inferay-white hover:bg-inferay-white/[0.08] active:scale-[0.97]"
					>
						<IconArrowLeft size={16} />
						Back
					</button>
					<button
						type="button"
						onClick={onComplete}
						className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-inferay-white px-5 text-[13px] font-medium text-inferay-black transition-all hover:opacity-85 active:scale-[0.97]"
					>
						{totalProjects > 0 ? "Let's build" : "Skip & enter"}
						<IconChevronRight size={16} />
					</button>
				</div>
			</div>
		</section>
	);
}
