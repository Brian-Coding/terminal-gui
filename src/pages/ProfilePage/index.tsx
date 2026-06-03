import * as stylex from "@stylexjs/stylex";
import { useCallback, useMemo, useReducer, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../../components/ui/Button.tsx";
import { DropdownButton } from "../../components/ui/DropdownButton.tsx";
import {
	IconPlus,
	IconRefreshCw,
	IconTerminal,
	IconX,
} from "../../components/ui/Icons.tsx";
import { Panel, PanelHeader } from "../../components/ui/Surface.tsx";
import { TextInput } from "../../components/ui/TextInput.tsx";
import {
	WorkspaceContent,
	WorkspacePage,
} from "../../components/ui/WorkspacePage.tsx";
import type { AgentAccountProviderStatus } from "../../features/agents/agent-account-status.ts";
import { getAgentIcon } from "../../features/agents/agent-ui.tsx";
import {
	type ChatAgentKind,
	CODEX_REASONING_LEVELS,
	getAgentDefinition,
	loadDefaultChatSettings,
	saveDefaultChatSettings,
} from "../../features/agents/agents.ts";
import { dispatchTerminalShellChange } from "../../features/terminal/terminal-utils.ts";
import {
	fetchForgeAccounts,
	fetchGithubRepos,
	getCachedForgeAccounts,
	getCachedGithubRepos,
	invalidateGithubReposCache,
} from "../../features/forge/forge-client.ts";
import type { GithubRepo } from "../../features/forge/types.ts";
import { useAppInfo } from "../../hooks/useAppInfo.ts";
import { useAsyncResource } from "../../hooks/useAsyncResource.ts";
import { ONBOARDING_DONE_STORAGE_KEY } from "../../lib/client-storage-keys.ts";
import { isActive, lacksValue } from "../../lib/data.ts";
import { fetchJsonOr, sendJsonWithBusy } from "../../lib/fetch-json.ts";
import { removeStoredValue } from "../../lib/stored-json.ts";
import { color, controlSize, font } from "../../tokens.stylex.ts";
import { TerminalSettingsContent } from "../Terminal/TerminalSettingsPanel.tsx";
import { ProfileAgentAccountCard } from "./ProfileAgentAccountCard.tsx";
import { ProfileGithubEmptyState, ProfileRepoRow } from "./ProfileGithub.tsx";
import {
	ProfileAccountAvatar,
	ProfileErrorBanner,
	ProfileSuccessBanner,
} from "./ProfileStatus.tsx";

type LoadState = "idle" | "loading" | "ready" | "error";
type StateValue<T> = T | ((current: T) => T);

type ProfileUiState = {
	error: string | null;
	connecting: boolean;
	repoQuery: string;
	cloneDirectory: string;
	cloneStatus: string | null;
	cloningRepo: string | null;
	simFoldersLoading: boolean;
	simFoldersStatus: string | null;
};

type ProfileUiAction<K extends keyof ProfileUiState = keyof ProfileUiState> = {
	type: "fieldChanged";
	field: K;
	value: StateValue<ProfileUiState[K]>;
};

const initialProfileUiState: ProfileUiState = {
	error: null,
	connecting: false,
	repoQuery: "",
	cloneDirectory: "~/Desktop",
	cloneStatus: null,
	cloningRepo: null,
	simFoldersLoading: false,
	simFoldersStatus: null,
};

function resolveStateValue<T>(current: T, value: StateValue<T>): T {
	return typeof value === "function"
		? (value as (current: T) => T)(current)
		: value;
}

function profileUiReducer(
	state: ProfileUiState,
	action: ProfileUiAction
): ProfileUiState {
	switch (action.type) {
		case "fieldChanged":
			return {
				...state,
				[action.field]: resolveStateValue(state[action.field], action.value),
			};
	}
}

async function fetchSimulatorProjectFolders(): Promise<string[]> {
	const response = await fetch("/api/simulator/project-folders");
	if (!response.ok) throw new Error(await response.text());
	const payload = (await response.json()) as { folders?: string[] };
	return Array.isArray(payload.folders) ? payload.folders : [];
}

export function ProfilePage() {
	const navigate = useNavigate();
	const resetOnboarding = () => {
		removeStoredValue(ONBOARDING_DONE_STORAGE_KEY);
		navigate("/onboarding", { replace: true });
	};
	const initialAccounts = getCachedForgeAccounts();
	const {
		data: accounts,
		loading: accountsLoading,
		error: accountsError,
	} = useAsyncResource(fetchForgeAccounts, initialAccounts);
	const loadState: LoadState = accountsLoading
		? "loading"
		: accountsError
			? "error"
			: accounts.length > 0
				? "ready"
				: "idle";
	const {
		data: simProjectFolders,
		setData: setSimProjectFolders,
		error: simProjectFoldersError,
	} = useAsyncResource(fetchSimulatorProjectFolders, []);
	const fetchRepos = useCallback(
		async () => (accounts.length > 0 ? fetchGithubRepos() : []),
		[accounts.length]
	);
	const {
		data: repos,
		loading: reposLoading,
		error: reposError,
		refresh: refreshRepos,
	} = useAsyncResource(fetchRepos, getCachedGithubRepos());
	const fetchAgentAccountStatuses = useCallback(
		async () =>
			fetchJsonOr<{ providers?: AgentAccountProviderStatus[] }>(
				"/api/agents/account-status",
				{}
			).then((payload) =>
				Array.isArray(payload.providers) ? payload.providers : []
			),
		[]
	);
	const {
		data: agentAccountStatuses,
		loading: agentAccountStatusesLoading,
		error: agentAccountStatusesError,
		refresh: refreshAgentAccountStatuses,
	} = useAsyncResource(fetchAgentAccountStatuses, []);
	const [profileUiState, profileUiDispatch] = useReducer(
		profileUiReducer,
		initialProfileUiState
	);
	const {
		error,
		connecting,
		repoQuery,
		cloneDirectory,
		cloneStatus,
		cloningRepo,
		simFoldersLoading,
		simFoldersStatus,
	} = profileUiState;
	const setProfileUiField = useCallback(
		<K extends keyof ProfileUiState>(
			field: K,
			value: StateValue<ProfileUiState[K]>
		) =>
			profileUiDispatch({
				type: "fieldChanged",
				field,
				value,
			} as ProfileUiAction),
		[]
	);
	const setError = useCallback(
		(value: StateValue<string | null>) => setProfileUiField("error", value),
		[setProfileUiField]
	);
	const setConnecting = useCallback(
		(value: StateValue<boolean>) => setProfileUiField("connecting", value),
		[setProfileUiField]
	);
	const setRepoQuery = useCallback(
		(value: StateValue<string>) => setProfileUiField("repoQuery", value),
		[setProfileUiField]
	);
	const setCloneDirectory = useCallback(
		(value: StateValue<string>) => setProfileUiField("cloneDirectory", value),
		[setProfileUiField]
	);
	const setCloneStatus = useCallback(
		(value: StateValue<string | null>) =>
			setProfileUiField("cloneStatus", value),
		[setProfileUiField]
	);
	const setCloningRepo = useCallback(
		(value: StateValue<string | null>) =>
			setProfileUiField("cloningRepo", value),
		[setProfileUiField]
	);
	const setSimFoldersLoading = useCallback(
		(value: StateValue<boolean>) =>
			setProfileUiField("simFoldersLoading", value),
		[setProfileUiField]
	);
	const setSimFoldersStatus = useCallback(
		(value: StateValue<string | null>) =>
			setProfileUiField("simFoldersStatus", value),
		[setProfileUiField]
	);
	const [defaultChatSettings, setDefaultChatSettings] = useState(() =>
		loadDefaultChatSettings()
	);
	const { data: appInfo } = useAppInfo();
	const defaultAgentDefinition = getAgentDefinition(
		defaultChatSettings.agentKind
	);
	const defaultModelOptions = defaultAgentDefinition.models.map((option) => ({
		...option,
		icon: getAgentIcon(defaultChatSettings.agentKind, 12),
	}));

	const updateDefaultChatSettings = (
		next: Partial<typeof defaultChatSettings>
	) => {
		const merged = loadDefaultChatSettings();
		const settings = { ...merged, ...next };
		const normalized = {
			...settings,
			model: getAgentDefinition(settings.agentKind).models.some(
				(option) => option.id === settings.model
			)
				? settings.model
				: getAgentDefinition(settings.agentKind).defaultModel,
		};
		saveDefaultChatSettings(normalized);
		setDefaultChatSettings(loadDefaultChatSettings());
	};

	const saveSimulatorProjectFolders = async (folders: string[]) => {
		const uniqueFolders = [...new Set(folders.map((folder) => folder.trim()))]
			.filter(Boolean)
			.sort((a, b) => a.localeCompare(b));
		const response = await fetch("/api/simulator/project-folders", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ folders: uniqueFolders }),
		});
		if (!response.ok) throw new Error(await response.text());
		const payload = (await response.json()) as { folders?: string[] };
		const nextFolders = Array.isArray(payload.folders)
			? payload.folders
			: uniqueFolders;
		setSimProjectFolders(nextFolders);
		return nextFolders;
	};

	const addSimulatorProjectFolder = async () => {
		setSimFoldersLoading(true);
		setSimFoldersStatus(null);
		try {
			const response = await fetch("/api/simulator/project-folders/pick", {
				method: "POST",
			});
			if (!response.ok) throw new Error(await response.text());
			const payload = (await response.json()) as { folder?: string | null };
			if (!payload.folder) return;
			const nextFolders = await saveSimulatorProjectFolders([
				...simProjectFolders,
				payload.folder,
			]);
			setSimFoldersStatus(`${nextFolders.length} project folders configured.`);
			navigate("/simulators");
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Unable to add project folder"
			);
		} finally {
			setSimFoldersLoading(false);
		}
	};

	const autoDetectSimulatorProjectFolders = async () => {
		setSimFoldersLoading(true);
		setSimFoldersStatus(null);
		try {
			const response = await fetch("/api/simulator/project-folders/detect", {
				method: "POST",
			});
			if (!response.ok) throw new Error(await response.text());
			const payload = (await response.json()) as { folders?: string[] };
			const nextFolders = Array.isArray(payload.folders) ? payload.folders : [];
			setSimProjectFolders(nextFolders);
			setSimFoldersStatus(
				nextFolders.length
					? `${nextFolders.length} project folders configured.`
					: "No simulator projects were detected."
			);
			if (nextFolders.length > 0) {
				navigate("/simulators");
			}
		} catch (err) {
			setError(
				err instanceof Error
					? err.message
					: "Unable to detect simulator project folders"
			);
		} finally {
			setSimFoldersLoading(false);
		}
	};

	const removeSimulatorProjectFolder = async (folder: string) => {
		setSimFoldersLoading(true);
		setSimFoldersStatus(null);
		try {
			const nextFolders = await saveSimulatorProjectFolders(
				simProjectFolders.filter(lacksValue.bind(null, folder))
			);
			setSimFoldersStatus(`${nextFolders.length} project folders configured.`);
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Unable to remove project folder"
			);
		} finally {
			setSimFoldersLoading(false);
		}
	};

	const loadRepos = useCallback(
		async (force = false) => {
			setError(null);
			if (force) invalidateGithubReposCache();
			await refreshRepos();
		},
		[refreshRepos, setError]
	);

	const resourceError =
		error ??
		simProjectFoldersError ??
		accountsError ??
		reposError ??
		agentAccountStatusesError;

	const activeAccount = useMemo(
		() => accounts.find(isActive) ?? accounts[0] ?? null,
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

	const connectGithub = sendJsonWithBusy.bind(
		null,
		setConnecting,
		"/api/forge/connect",
		{ provider: "github" },
		undefined
	);

	const pickCloneDirectory = async () => {
		const payload = await fetchJsonOr<{ folder: string | null }>(
			"/api/config/pick-folder",
			{ folder: null },
			{ method: "POST" }
		);
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
			invalidateGithubReposCache();
			setCloneStatus(`Cloned ${repo.full_name} to ${payload.displayPath}`);
			dispatchTerminalShellChange({ source: "cache", reason: "repo-cloned" });
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Unable to clone repository"
			);
		} finally {
			setCloningRepo(null);
		}
	};

	return (
		<WorkspacePage>
			<WorkspaceContent scroll>
				<div {...stylex.props(styles.content)}>
					<section {...stylex.props(styles.profileSummary)}>
						<div {...stylex.props(styles.accountPreview)}>
							<ProfileAccountAvatar account={activeAccount} size="md" />
							<div {...stylex.props(styles.rowText)}>
								<p {...stylex.props(styles.profileName)}>
									{activeAccount?.name ||
										activeAccount?.login ||
										"GitHub Account"}
								</p>
								<p {...stylex.props(styles.profileMeta)}>
									{activeAccount ? `@${activeAccount.login}` : "Not connected"}
								</p>
								<p {...stylex.props(styles.versionMeta)}>
									inferay {appInfo.version}
								</p>
							</div>
						</div>
						<div {...stylex.props(styles.profileActionCards)}>
							{!activeAccount ? (
								<button
									type="button"
									onClick={connectGithub}
									disabled={connecting}
									{...stylex.props(styles.profileActionCard)}
								>
									<span {...stylex.props(styles.profileActionIcon)}>
										<IconTerminal size={14} />
									</span>
									<span {...stylex.props(styles.profileActionTextGroup)}>
										<span {...stylex.props(styles.profileActionTitle)}>
											{connecting ? "Opening..." : "Connect GitHub"}
										</span>
										<span {...stylex.props(styles.profileActionText)}>
											Use your local GitHub CLI login.
										</span>
									</span>
								</button>
							) : null}
							{!appInfo.production ? (
								<button
									type="button"
									onClick={resetOnboarding}
									{...stylex.props(styles.profileActionCard)}
								>
									<span {...stylex.props(styles.profileActionIcon)}>
										<IconRefreshCw size={14} />
									</span>
									<span {...stylex.props(styles.profileActionTextGroup)}>
										<span {...stylex.props(styles.profileActionTitle)}>
											Replay Onboarding
										</span>
										<span {...stylex.props(styles.profileActionText)}>
											Reset setup and walk through it again.
										</span>
									</span>
								</button>
							) : null}
						</div>
					</section>

					<Panel>
						<PanelHeader
							title="Appearance"
							description="Choose the app theme, diff syntax theme, and project search folders."
						/>
						<TerminalSettingsContent showVersion={false} />
					</Panel>

					<Panel>
						<PanelHeader
							title="New Chat Defaults"
							description="Choose which agent, model, and reasoning level new panes use when you press New."
						/>
						<div {...stylex.props(styles.defaultSettingsGrid)}>
							<div {...stylex.props(styles.settingField)}>
								<span {...stylex.props(styles.settingLabel)}>Agent</span>
								<DropdownButton
									value={defaultChatSettings.agentKind}
									options={(["claude", "codex"] as const).map((kind) => ({
										id: kind,
										label: getAgentDefinition(kind).label,
										icon: getAgentIcon(kind, 12),
									}))}
									onChange={(id) => {
										const agentKind = id as ChatAgentKind;
										updateDefaultChatSettings({
											agentKind,
											model: getAgentDefinition(agentKind).defaultModel,
										});
									}}
									fullWidth
								/>
							</div>
							<div {...stylex.props(styles.settingField)}>
								<span {...stylex.props(styles.settingLabel)}>Model</span>
								<DropdownButton
									value={defaultChatSettings.model}
									options={defaultModelOptions}
									onChange={(model) => updateDefaultChatSettings({ model })}
									fullWidth
								/>
							</div>
							{defaultChatSettings.agentKind === "codex" ? (
								<div {...stylex.props(styles.settingField)}>
									<span {...stylex.props(styles.settingLabel)}>Reasoning</span>
									<DropdownButton
										value={defaultChatSettings.reasoningLevel}
										options={CODEX_REASONING_LEVELS.map((level) => ({
											id: level.id,
											label: level.label,
											detail: level.detail,
										}))}
										onChange={(reasoningLevel) =>
											updateDefaultChatSettings({ reasoningLevel })
										}
										fullWidth
									/>
								</div>
							) : null}
						</div>
					</Panel>

					<Panel>
						<PanelHeader
							title="Claude / Codex Accounts"
							description="Read-only local CLI health, auth hints, and usage visibility. Account switching stays inside the native CLIs."
							actions={
								<Button
									type="button"
									onClick={() => void refreshAgentAccountStatuses()}
									variant="secondary"
									size="sm"
								>
									<IconRefreshCw size={12} />
									<span>Refresh</span>
								</Button>
							}
						/>
						<div {...stylex.props(styles.agentAccountGrid)}>
							{agentAccountStatusesLoading &&
							agentAccountStatuses.length === 0 ? (
								<div {...stylex.props(styles.agentAccountLoading)}>
									Checking local agent CLIs…
								</div>
							) : (
								agentAccountStatuses.map((status) => (
									<ProfileAgentAccountCard key={status.kind} status={status} />
								))
							)}
						</div>
					</Panel>

					<Panel>
						<PanelHeader
							title="Xcode Projects"
							description="Configure folders Inferay scans for Xcode and React Native simulator apps."
							actions={
								<div {...stylex.props(styles.panelActions)}>
									<Button
										type="button"
										onClick={() => void autoDetectSimulatorProjectFolders()}
										disabled={simFoldersLoading}
										variant="secondary"
										size="sm"
									>
										<IconRefreshCw size={12} />
										<span>Auto Detect</span>
									</Button>
									<Button
										type="button"
										onClick={() => void addSimulatorProjectFolder()}
										disabled={simFoldersLoading}
										variant="primary"
										size="sm"
									>
										<IconPlus size={12} />
										<span>Add Folder</span>
									</Button>
								</div>
							}
						/>
						<div {...stylex.props(styles.projectFolderBody)}>
							{simProjectFolders.length === 0 ? (
								<div {...stylex.props(styles.projectFolderEmpty)}>
									Add your iOS app root, Xcode project folder, or React Native
									repo so Simulators can build and launch it.
								</div>
							) : (
								<div {...stylex.props(styles.projectFolderList)}>
									{simProjectFolders.map((folder) => (
										<div
											key={folder}
											{...stylex.props(styles.projectFolderRow)}
										>
											<div {...stylex.props(styles.projectFolderIcon)}>
												<IconTerminal size={13} />
											</div>
											<span {...stylex.props(styles.projectFolderPath)}>
												{folder}
											</span>
											<button
												type="button"
												aria-label={`Remove ${folder}`}
												onClick={() =>
													void removeSimulatorProjectFolder(folder)
												}
												disabled={simFoldersLoading}
												{...stylex.props(styles.projectFolderRemove)}
											>
												<IconX size={12} />
											</button>
										</div>
									))}
								</div>
							)}
							{simFoldersStatus ? (
								<p {...stylex.props(styles.projectFolderStatus)}>
									{simFoldersStatus}
								</p>
							) : null}
						</div>
					</Panel>

					<header {...stylex.props(styles.header)}>
						<div>
							<h1 {...stylex.props(styles.title)}>GitHub</h1>
							<p {...stylex.props(styles.description)}>
								Inferay uses your local GitHub CLI login for repositories.
							</p>
						</div>
					</header>

					{resourceError ? (
						<ProfileErrorBanner message={resourceError} />
					) : null}
					{cloneStatus ? <ProfileSuccessBanner message={cloneStatus} /> : null}

					{loadState === "loading" || accounts.length === 0 ? (
						<Panel>
							{loadState === "loading" ? (
								<div {...stylex.props(styles.accountLoadingState)}>
									Checking GitHub CLI account…
								</div>
							) : (
								<ProfileGithubEmptyState onConnect={connectGithub} />
							)}
						</Panel>
					) : null}

					{accounts.length > 0 ? (
						<Panel>
							<PanelHeader
								title="Clone from GitHub"
								description="Discover repositories from your connected account and add the clone location to Inferay search."
								actions={
									<Button
										type="button"
										onClick={() => void loadRepos(true)}
										variant="secondary"
										size="sm"
										className={stylex.props(styles.noShrink).className}
									>
										<IconRefreshCw size={12} />
										<span>Repos</span>
									</Button>
								}
							/>
							<div {...stylex.props(styles.cloneControls)}>
								<TextInput
									type="text"
									value={repoQuery}
									onChange={(event) => setRepoQuery(event.target.value)}
									placeholder="Search repositories"
									fullWidth
									className={stylex.props(styles.flexInput).className}
								/>
								<div {...stylex.props(styles.cloneDirControls)}>
									<TextInput
										type="text"
										value={cloneDirectory}
										onChange={(event) => setCloneDirectory(event.target.value)}
										fullWidth
										className={stylex.props(styles.flexInput).className}
									/>
									<Button
										type="button"
										onClick={() => void pickCloneDirectory()}
										variant="ghost"
										size="md"
										className={stylex.props(styles.noShrink).className}
									>
										Browse
									</Button>
								</div>
							</div>
							<div {...stylex.props(styles.repoList)}>
								{reposLoading ? (
									<div {...stylex.props(styles.loadingState)}>
										Loading repositories…
									</div>
								) : filteredRepos.length === 0 ? (
									<div {...stylex.props(styles.loadingState)}>
										No repositories found.
									</div>
								) : (
									filteredRepos.map((repo) => (
										<ProfileRepoRow
											key={repo.full_name}
											repo={repo}
											cloning={cloningRepo === repo.full_name}
											onClone={() => void cloneRepo(repo)}
										/>
									))
								)}
							</div>
						</Panel>
					) : null}
				</div>
			</WorkspaceContent>
		</WorkspacePage>
	);
}

const styles = stylex.create({
	accountPreview: {
		display: "flex",
		alignItems: "center",
		gap: controlSize._3,
	},
	rowText: {
		minWidth: 0,
		flex: 1,
	},
	profileSummary: {
		display: "flex",
		alignItems: {
			default: "flex-start",
			"@media (min-width: 720px)": "center",
		},
		justifyContent: "space-between",
		gap: controlSize._3,
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: color.border,
		paddingBottom: controlSize._4,
	},
	profileActionCards: {
		display: "grid",
		gridTemplateColumns: {
			default: "1fr",
			"@media (min-width: 720px)": "repeat(2, minmax(0, 1fr))",
		},
		gap: controlSize._2,
		minWidth: {
			default: "100%",
			"@media (min-width: 720px)": "360px",
		},
	},
	profileActionCard: {
		display: "flex",
		alignItems: "center",
		gap: controlSize._3,
		backgroundColor: {
			default: color.transparent,
			":hover": color.surfaceSubtle,
		},
		paddingBlock: controlSize._2,
		paddingInline: 0,
		textAlign: "left",
		transitionProperty: "background-color, opacity",
		transitionDuration: "120ms",
		":disabled": {
			cursor: "default",
			opacity: 0.7,
		},
	},
	profileActionIcon: {
		display: "flex",
		width: controlSize._7,
		height: controlSize._7,
		flexShrink: 0,
		alignItems: "center",
		justifyContent: "center",
		color: color.textSoft,
	},
	profileActionTextGroup: {
		display: "flex",
		minWidth: 0,
		flexDirection: "column",
	},
	profileActionTitle: {
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
		color: color.textMain,
		fontSize: font.size_3,
		fontWeight: font.weight_5,
	},
	profileActionText: {
		marginTop: "0.125rem",
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
		color: color.textMuted,
		fontSize: font.size_1,
	},
	profileName: {
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
		color: color.textMain,
		fontSize: "0.8125rem",
		fontWeight: font.weight_5,
	},
	profileMeta: {
		marginTop: "0.125rem",
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
		color: color.textMuted,
		fontSize: font.size_2,
	},
	versionMeta: {
		marginTop: "0.1875rem",
		color: color.textMuted,
		fontSize: font.size_1,
	},
	defaultSettingsGrid: {
		display: "grid",
		gridTemplateColumns: {
			default: "1fr",
			"@media (min-width: 760px)": "repeat(3, minmax(0, 1fr))",
		},
		gap: controlSize._3,
		padding: controlSize._4,
	},
	agentAccountGrid: {
		borderTopWidth: 1,
		borderTopStyle: "solid",
		borderTopColor: color.border,
		display: "grid",
		gap: controlSize._3,
		gridTemplateColumns: {
			default: "1fr",
			"@media (min-width: 760px)": "repeat(2, minmax(0, 1fr))",
		},
		padding: controlSize._4,
	},
	agentAccountLoading: {
		alignItems: "center",
		color: color.textMuted,
		display: "flex",
		fontSize: font.size_2,
		justifyContent: "center",
		minHeight: "6rem",
	},
	settingField: {
		display: "flex",
		minWidth: 0,
		flexDirection: "column",
		gap: controlSize._1,
	},
	settingLabel: {
		color: color.textMuted,
		fontSize: font.size_1,
		fontWeight: font.weight_5,
	},
	noShrink: {
		flexShrink: 0,
	},
	flexInput: {
		flex: 1,
	},
	content: {
		display: "flex",
		maxWidth: "56rem",
		flexDirection: "column",
		gap: controlSize._4,
		marginInline: "auto",
		paddingBlock: controlSize._5,
		paddingInline: controlSize._6,
	},
	header: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: controlSize._3,
	},
	title: {
		color: color.textMain,
		fontSize: "0.8125rem",
		fontWeight: font.weight_5,
	},
	description: {
		marginTop: controlSize._1,
		color: color.textMuted,
		fontSize: font.size_1,
	},
	panelActions: {
		display: "flex",
		alignItems: "center",
		gap: controlSize._2,
	},
	projectFolderBody: {
		display: "flex",
		flexDirection: "column",
		gap: controlSize._2,
		borderTopWidth: 1,
		borderTopStyle: "solid",
		borderTopColor: color.border,
		padding: controlSize._4,
	},
	projectFolderList: {
		display: "flex",
		flexDirection: "column",
		gap: controlSize._1,
	},
	projectFolderRow: {
		display: "flex",
		minHeight: "2.25rem",
		alignItems: "center",
		gap: controlSize._2,
		backgroundColor: {
			default: color.transparent,
			":hover": color.surfaceSubtle,
		},
		paddingBlock: controlSize._1,
		paddingInline: 0,
	},
	projectFolderIcon: {
		display: "flex",
		width: controlSize._6,
		height: controlSize._6,
		flexShrink: 0,
		alignItems: "center",
		justifyContent: "center",
		color: color.textMuted,
	},
	projectFolderPath: {
		minWidth: 0,
		flex: 1,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
		color: color.textMain,
		fontSize: font.size_2,
	},
	projectFolderRemove: {
		display: "flex",
		width: controlSize._6,
		height: controlSize._6,
		flexShrink: 0,
		alignItems: "center",
		justifyContent: "center",
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: color.transparent,
		borderRadius: controlSize._1,
		backgroundColor: {
			default: color.transparent,
			":hover": color.controlHover,
		},
		color: {
			default: color.textMuted,
			":hover": color.textSoft,
		},
		":disabled": {
			opacity: 0.45,
		},
	},
	projectFolderEmpty: {
		display: "flex",
		minHeight: "5rem",
		alignItems: "center",
		justifyContent: "center",
		color: color.textMuted,
		fontSize: font.size_2,
		lineHeight: 1.5,
		padding: controlSize._4,
		textAlign: "center",
	},
	projectFolderStatus: {
		color: color.textMuted,
		fontSize: font.size_1,
	},
	cloneControls: {
		display: "flex",
		flexDirection: {
			default: "column",
			"@media (min-width: 768px)": "row",
		},
		gap: controlSize._2,
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: color.border,
		paddingBlock: controlSize._3,
		paddingInline: controlSize._4,
	},
	cloneDirControls: {
		display: "flex",
		minWidth: 0,
		alignItems: "center",
		gap: controlSize._2,
		width: {
			default: "auto",
			"@media (min-width: 768px)": "320px",
		},
	},
	repoList: {
		maxHeight: "320px",
		overflowY: "auto",
	},
	loadingState: {
		display: "flex",
		height: "6rem",
		alignItems: "center",
		justifyContent: "center",
		color: color.textMuted,
		fontSize: font.size_2,
	},
	accountLoadingState: {
		display: "flex",
		height: "7rem",
		alignItems: "center",
		justifyContent: "center",
		color: color.textMuted,
		fontSize: "0.625rem",
	},
});
