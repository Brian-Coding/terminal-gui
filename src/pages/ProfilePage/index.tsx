import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
	IconAlertTriangle,
	IconCheck,
	IconExternalLink,
	IconGitBranch,
	IconPlus,
	IconRefreshCw,
	IconTerminal,
	IconUser,
} from "../../components/ui/Icons.tsx";
import { ONBOARDING_DONE_KEY } from "../OnboardingPage/index.tsx";

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

type LoadState = "idle" | "loading" | "ready" | "error";
const PROFILE_CACHE_TTL_MS = 120_000;

let cachedAccounts: { value: ForgeAccount[]; cachedAt: number } | null = null;
let cachedRepos: { value: GithubRepo[]; cachedAt: number } | null = null;

function isFresh(cachedAt: number) {
	return Date.now() - cachedAt < PROFILE_CACHE_TTL_MS;
}

export function ProfilePage() {
	const navigate = useNavigate();
	const resetOnboarding = () => {
		localStorage.removeItem(ONBOARDING_DONE_KEY);
		navigate("/onboarding", { replace: true });
	};
	const [accounts, setAccounts] = useState<ForgeAccount[]>(
		cachedAccounts && isFresh(cachedAccounts.cachedAt)
			? cachedAccounts.value
			: []
	);
	const [loadState, setLoadState] = useState<LoadState>(
		cachedAccounts && isFresh(cachedAccounts.cachedAt) ? "ready" : "idle"
	);
	const [error, setError] = useState<string | null>(null);
	const [connecting, setConnecting] = useState(false);
	const [repos, setRepos] = useState<GithubRepo[]>(
		cachedRepos && isFresh(cachedRepos.cachedAt) ? cachedRepos.value : []
	);
	const [reposLoading, setReposLoading] = useState(false);
	const [repoQuery, setRepoQuery] = useState("");
	const [cloneDirectory, setCloneDirectory] = useState("~/Desktop");
	const [cloneStatus, setCloneStatus] = useState<string | null>(null);
	const [cloningRepo, setCloningRepo] = useState<string | null>(null);

	const loadAccounts = useCallback(async (force = false) => {
		if (!force && cachedAccounts && isFresh(cachedAccounts.cachedAt)) {
			setAccounts(cachedAccounts.value);
			setLoadState("ready");
			return;
		}
		if (force || !cachedAccounts || !isFresh(cachedAccounts.cachedAt)) {
			setLoadState("loading");
		}
		setError(null);
		try {
			const response = await fetch("/api/forge/accounts");
			if (!response.ok) {
				throw new Error(await response.text());
			}
			const payload = (await response.json()) as { accounts?: ForgeAccount[] };
			const nextAccounts = Array.isArray(payload.accounts)
				? payload.accounts
				: [];
			cachedAccounts = { value: nextAccounts, cachedAt: Date.now() };
			setAccounts(nextAccounts);
			setLoadState("ready");
		} catch (err) {
			setError(err instanceof Error ? err.message : "Unable to load accounts");
			setLoadState("error");
		}
	}, []);

	useEffect(() => {
		void loadAccounts();
	}, [loadAccounts]);

	const loadRepos = useCallback(async (force = false) => {
		if (!force && cachedRepos && isFresh(cachedRepos.cachedAt)) {
			setRepos(cachedRepos.value);
			return;
		}
		setReposLoading(true);
		try {
			const response = await fetch("/api/forge/repos?limit=50");
			if (!response.ok) throw new Error(await response.text());
			const payload = (await response.json()) as { repos?: GithubRepo[] };
			const nextRepos = Array.isArray(payload.repos) ? payload.repos : [];
			cachedRepos = { value: nextRepos, cachedAt: Date.now() };
			setRepos(nextRepos);
		} catch (err) {
			setError(
				err instanceof Error
					? err.message
					: "Unable to load GitHub repositories"
			);
		} finally {
			setReposLoading(false);
		}
	}, []);

	useEffect(() => {
		if (accounts.length > 0) {
			void loadRepos();
		}
	}, [accounts.length, loadRepos]);

	const activeAccount = useMemo(
		() => accounts.find((account) => account.active) ?? accounts[0] ?? null,
		[accounts]
	);

	const filteredRepos = useMemo(() => {
		const query = repoQuery.trim().toLowerCase();
		if (!query) return repos;
		return repos.filter(
			(repo) =>
				repo.full_name.toLowerCase().includes(query) ||
				repo.description?.toLowerCase().includes(query)
		);
	}, [repoQuery, repos]);

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

	const pickCloneDirectory = async () => {
		const response = await fetch("/api/config/pick-folder", { method: "POST" });
		const payload = (await response.json()) as { folder: string | null };
		if (payload.folder) setCloneDirectory(payload.folder);
	};

	const cloneRepo = async (repo: GithubRepo) => {
		setCloningRepo(repo.full_name);
		setCloneStatus(null);
		setError(null);
		try {
			const response = await fetch("/api/forge/clone", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					gitUrl: repo.html_url,
					cloneDirectory,
				}),
			});
			const payload = (await response.json()) as {
				error?: string;
				displayPath?: string;
			};
			if (!response.ok) throw new Error(payload.error ?? "Clone failed");
			cachedRepos = null;
			setCloneStatus(`Cloned ${repo.full_name} to ${payload.displayPath}`);
			window.dispatchEvent(new Event("terminal-shell-change"));
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Unable to clone repository"
			);
		} finally {
			setCloningRepo(null);
		}
	};

	return (
		<div className="flex h-full min-h-0 bg-inferay-black">
			<aside className="flex w-[220px] shrink-0 flex-col border-r border-inferay-gray-border bg-inferay-black">
				<div className="border-b border-inferay-gray-border px-4 py-4">
					<div className="flex items-center gap-3">
						<AccountAvatar account={activeAccount} size="md" />
						<div className="min-w-0">
							<p className="truncate text-[11px] font-medium text-inferay-white">
								{activeAccount?.name ||
									activeAccount?.login ||
									"GitHub Account"}
							</p>
							<p className="truncate text-[8px] text-inferay-muted-gray">
								{activeAccount ? `@${activeAccount.login}` : "Not connected"}
							</p>
						</div>
					</div>
				</div>

				<nav className="flex-1 px-3 py-3">
					<div className="flex h-8 w-full items-center gap-2 rounded-lg border border-inferay-gray-border bg-inferay-gray px-2.5 text-[10px] text-inferay-white">
						<IconGitBranch size={13} className="text-inferay-muted-gray" />
						<span>GitHub</span>
						<span className="ml-auto text-[8px] tabular-nums text-inferay-muted-gray">
							{accounts.length}
						</span>
					</div>
				</nav>

				<div className="flex flex-col gap-2 border-t border-inferay-gray-border p-3">
					<button
						type="button"
						onClick={connectGithub}
						disabled={connecting}
						className="flex h-8 w-full items-center justify-center gap-2 rounded-lg border border-inferay-gray-border text-[10px] text-inferay-muted-gray transition-colors hover:bg-inferay-dark-gray hover:text-inferay-soft-white disabled:opacity-50"
					>
						<IconTerminal size={13} />
						<span>{connecting ? "Opening..." : "Connect GitHub"}</span>
					</button>
					<button
						type="button"
						onClick={resetOnboarding}
						className="flex h-8 w-full items-center justify-center gap-2 rounded-lg border border-inferay-gray-border text-[10px] text-inferay-muted-gray transition-colors hover:bg-inferay-dark-gray hover:text-inferay-soft-white"
					>
						<IconRefreshCw size={13} />
						<span>Replay Onboarding</span>
					</button>
				</div>
			</aside>

			<main className="min-w-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex max-w-4xl flex-col gap-4 px-6 py-5">
					<header className="flex items-center justify-between gap-3">
						<div>
							<h1 className="text-[13px] font-medium text-inferay-white">
								GitHub Accounts
							</h1>
							<p className="mt-1 text-[9px] text-inferay-muted-gray">
								Inferay uses your local GitHub CLI login, the same way Helmor
								detects accounts.
							</p>
						</div>
						<div className="flex items-center gap-2">
							<button
								type="button"
								onClick={() => void loadAccounts(true)}
								className="flex h-7 items-center gap-1.5 rounded-md border border-inferay-gray-border bg-inferay-dark-gray px-2.5 text-[9px] text-inferay-soft-white transition-colors hover:bg-inferay-gray"
							>
								<IconRefreshCw size={12} />
								<span>Refresh</span>
							</button>
							<button
								type="button"
								onClick={connectGithub}
								className="flex h-7 items-center gap-1.5 rounded-md border border-inferay-gray-border bg-inferay-gray px-2.5 text-[9px] font-medium text-inferay-white transition-colors hover:border-inferay-accent hover:bg-inferay-accent hover:text-black"
							>
								<IconTerminal size={12} />
								<span>Connect</span>
							</button>
						</div>
					</header>

					{error ? <ErrorBanner message={error} /> : null}
					{cloneStatus ? <SuccessBanner message={cloneStatus} /> : null}

					<section className="overflow-hidden rounded-lg border border-inferay-gray-border bg-inferay-dark-gray/20">
						{loadState === "loading" ? (
							<div className="flex h-28 items-center justify-center text-[10px] text-inferay-muted-gray">
								Checking GitHub CLI accounts...
							</div>
						) : accounts.length === 0 ? (
							<EmptyState onConnect={connectGithub} />
						) : (
							accounts.map((account) => (
								<AccountRow
									key={`${account.host}:${account.login}`}
									account={account}
								/>
							))
						)}
					</section>

					{accounts.length > 0 ? (
						<section className="rounded-lg border border-inferay-gray-border bg-inferay-dark-gray/20">
							<div className="flex items-center justify-between gap-3 border-b border-inferay-gray-border px-4 py-3">
								<div className="min-w-0">
									<h2 className="text-[11px] font-medium text-inferay-white">
										Clone from GitHub
									</h2>
									<p className="mt-1 text-[8px] text-inferay-muted-gray">
										Discover repositories from your connected account and add
										the clone location to Inferay search.
									</p>
								</div>
								<button
									type="button"
									onClick={() => void loadRepos(true)}
									className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-inferay-gray-border bg-inferay-dark-gray px-2.5 text-[9px] text-inferay-soft-white transition-colors hover:bg-inferay-gray"
								>
									<IconRefreshCw size={12} />
									<span>Repos</span>
								</button>
							</div>
							<div className="flex flex-col gap-2 border-b border-inferay-gray-border px-4 py-3 md:flex-row">
								<input
									type="text"
									value={repoQuery}
									onChange={(event) => setRepoQuery(event.target.value)}
									placeholder="Search repositories"
									className="h-8 min-w-0 flex-1 rounded-md border border-inferay-gray-border bg-inferay-black px-2.5 text-[10px] text-inferay-white outline-none placeholder:text-inferay-muted-gray focus:border-inferay-accent/60"
								/>
								<div className="flex min-w-0 items-center gap-2 md:w-[320px]">
									<input
										type="text"
										value={cloneDirectory}
										onChange={(event) => setCloneDirectory(event.target.value)}
										className="h-8 min-w-0 flex-1 rounded-md border border-inferay-gray-border bg-inferay-black px-2.5 text-[10px] text-inferay-white outline-none focus:border-inferay-accent/60"
									/>
									<button
										type="button"
										onClick={() => void pickCloneDirectory()}
										className="h-8 shrink-0 rounded-md border border-inferay-gray-border px-2.5 text-[9px] text-inferay-muted-gray transition-colors hover:bg-inferay-dark-gray hover:text-inferay-soft-white"
									>
										Browse
									</button>
								</div>
							</div>
							<div className="max-h-[320px] overflow-y-auto">
								{reposLoading ? (
									<div className="flex h-24 items-center justify-center text-[10px] text-inferay-muted-gray">
										Loading repositories...
									</div>
								) : filteredRepos.length === 0 ? (
									<div className="flex h-24 items-center justify-center text-[10px] text-inferay-muted-gray">
										No repositories found.
									</div>
								) : (
									filteredRepos.map((repo) => (
										<RepoRow
											key={repo.full_name}
											repo={repo}
											cloning={cloningRepo === repo.full_name}
											onClone={() => void cloneRepo(repo)}
										/>
									))
								)}
							</div>
						</section>
					) : null}
				</div>
			</main>
		</div>
	);
}

function RepoRow({
	repo,
	cloning,
	onClone,
}: {
	repo: GithubRepo;
	cloning: boolean;
	onClone: () => void;
}) {
	return (
		<div className="flex min-h-[64px] items-center gap-3 border-b border-inferay-gray-border px-4 py-3 last:border-b-0">
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<p className="truncate text-[10px] font-medium text-inferay-white">
						{repo.full_name}
					</p>
					{repo.private ? (
						<span className="rounded-full border border-inferay-gray-border px-1.5 py-0.5 text-[7px] text-inferay-muted-gray">
							Private
						</span>
					) : null}
				</div>
				<p className="mt-1 truncate text-[8px] text-inferay-muted-gray">
					{repo.description || repo.language || "No description"}
				</p>
			</div>
			<a
				href={repo.html_url}
				target="_blank"
				rel="noreferrer"
				className="flex h-7 w-7 items-center justify-center rounded-md border border-inferay-gray-border text-inferay-muted-gray transition-colors hover:bg-inferay-dark-gray hover:text-inferay-soft-white"
				title="Open on GitHub"
			>
				<IconExternalLink size={12} />
			</a>
			<button
				type="button"
				onClick={onClone}
				disabled={cloning}
				className="flex h-7 items-center gap-1.5 rounded-md border border-inferay-gray-border bg-inferay-gray px-2.5 text-[9px] text-inferay-white transition-colors hover:border-inferay-accent hover:bg-inferay-accent hover:text-black disabled:opacity-50"
			>
				<IconPlus size={12} />
				<span>{cloning ? "Cloning" : "Clone"}</span>
			</button>
		</div>
	);
}

function AccountRow({ account }: { account: ForgeAccount }) {
	const displayName = account.name?.trim() || account.login;
	const githubUrl = `https://${account.host}/${account.login}`;

	return (
		<div className="flex min-h-[74px] items-center gap-3 border-b border-inferay-gray-border px-4 py-3 last:border-b-0">
			<AccountAvatar account={account} size="lg" />
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<p className="truncate text-[11px] font-medium text-inferay-white">
						{displayName}
					</p>
					<p className="truncate text-[10px] text-inferay-muted-gray">
						@{account.login}
					</p>
					{account.active ? (
						<span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/12 px-1.5 py-0.5 text-[7px] font-medium text-emerald-400">
							<IconCheck size={9} />
							Active
						</span>
					) : null}
				</div>
				<div className="mt-1 flex min-h-4 items-center gap-2 text-[8px] text-inferay-muted-gray">
					<span>{account.host}</span>
					{account.email ? <span>{account.email}</span> : null}
				</div>
			</div>
			<a
				href={githubUrl}
				target="_blank"
				rel="noreferrer"
				className="flex h-7 w-7 items-center justify-center rounded-md border border-inferay-gray-border text-inferay-muted-gray transition-colors hover:bg-inferay-dark-gray hover:text-inferay-soft-white"
				title="Open on GitHub"
			>
				<IconExternalLink size={12} />
			</a>
		</div>
	);
}

function AccountAvatar({
	account,
	size,
}: {
	account: ForgeAccount | null;
	size: "md" | "lg";
}) {
	const className =
		size === "lg" ? "h-10 w-10 text-[13px]" : "h-10 w-10 text-[12px]";
	const fallback = account?.login.slice(0, 2).toUpperCase() || "GH";

	return (
		<div
			className={`flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-inferay-gray-border bg-inferay-gray font-semibold text-inferay-soft-white ${className}`}
		>
			{account?.avatarUrl ? (
				<img
					src={account.avatarUrl}
					alt={account.login}
					className="h-full w-full object-cover"
				/>
			) : account ? (
				fallback
			) : (
				<IconUser size={18} />
			)}
		</div>
	);
}

function EmptyState({ onConnect }: { onConnect: () => void }) {
	return (
		<div className="flex min-h-[180px] flex-col items-center justify-center gap-3 px-6 text-center">
			<div className="flex h-10 w-10 items-center justify-center rounded-full border border-inferay-gray-border bg-inferay-dark-gray text-inferay-muted-gray">
				<IconGitBranch size={17} />
			</div>
			<div>
				<p className="text-[11px] font-medium text-inferay-white">
					No GitHub accounts found
				</p>
				<p className="mt-1 max-w-sm text-[9px] leading-relaxed text-inferay-muted-gray">
					Connect with the GitHub CLI and Inferay will pick up the account
					automatically.
				</p>
			</div>
			<button
				type="button"
				onClick={onConnect}
				className="flex h-7 items-center gap-1.5 rounded-md border border-inferay-gray-border bg-inferay-gray px-2.5 text-[9px] font-medium text-inferay-white transition-colors hover:border-inferay-accent hover:bg-inferay-accent hover:text-black"
			>
				<IconTerminal size={12} />
				<span>Run gh auth login</span>
			</button>
		</div>
	);
}

function ErrorBanner({ message }: { message: string }) {
	return (
		<div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/8 px-3 py-2 text-[9px] text-amber-200">
			<IconAlertTriangle size={13} className="mt-0.5 shrink-0" />
			<span className="min-w-0 break-words">{message}</span>
		</div>
	);
}

function SuccessBanner({ message }: { message: string }) {
	return (
		<div className="flex items-start gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-[9px] text-emerald-200">
			<IconCheck size={13} className="mt-0.5 shrink-0" />
			<span className="min-w-0 break-words">{message}</span>
		</div>
	);
}
