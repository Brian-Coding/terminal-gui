import type React from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconChevronDown } from "./Icons.tsx";

interface DropdownOption {
	id: string;
	label: string;
	detail?: string;
	status?: string;
	icon?: React.ReactNode;
}

interface DropdownButtonProps {
	value: string | null;
	options: DropdownOption[];
	onChange: (id: string) => void;
	placeholder?: string;
	icon?: React.ReactNode;
	emptyLabel?: string;
	minWidth?: number;
	fullWidth?: boolean;
	renderOption?: (opt: DropdownOption, isSelected: boolean) => React.ReactNode;
	buttonClassName?: string;
	labelClassName?: string;
	menuPlacement?: "auto" | "top" | "bottom";
}

function DropdownCustomOption({
	opt,
	isSelected,
	renderOption,
	onChange,
	setOpen,
}: {
	opt: DropdownOption;
	isSelected: boolean;
	renderOption: (opt: DropdownOption, isSelected: boolean) => React.ReactNode;
	onChange: (id: string) => void;
	setOpen: (v: boolean) => void;
}) {
	return (
		<div
			role="button"
			tabIndex={0}
			onClick={() => {
				onChange(opt.id);
				setOpen(false);
			}}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onChange(opt.id);
					setOpen(false);
				}
			}}
			className="cursor-pointer"
		>
			{renderOption(opt, isSelected)}
		</div>
	);
}

export function DropdownButton({
	value,
	options,
	onChange,
	placeholder = "Select...",
	icon,
	emptyLabel = "No options",
	minWidth = 220,
	fullWidth = false,
	renderOption,
	buttonClassName,
	labelClassName = "",
	menuPlacement = "auto",
}: DropdownButtonProps) {
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	const btnRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const [pos, setPos] = useState({
		top: 0,
		left: 0,
		width: 0,
		maxH: 300,
		placement: "bottom" as "top" | "bottom",
	});
	useEffect(() => {
		if (!open) return;
		const handleClick = (e: MouseEvent) => {
			if (
				menuRef.current &&
				!menuRef.current.contains(e.target as Node) &&
				!btnRef.current?.contains(e.target as Node)
			) {
				setOpen(false);
			}
		};
		const handleScroll = (e: Event) => {
			if (menuRef.current?.contains(e.target as Node)) return;
			setOpen(false);
		};
		const handleKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", handleClick);
		window.addEventListener("scroll", handleScroll, true);
		document.addEventListener("keydown", handleKey);
		return () => {
			document.removeEventListener("mousedown", handleClick);
			window.removeEventListener("scroll", handleScroll, true);
			document.removeEventListener("keydown", handleKey);
		};
	}, [open]);
	const toggle = () => {
		if (!open && btnRef.current) {
			const rect = btnRef.current.getBoundingClientRect();
			const spaceBelow = window.innerHeight - rect.bottom - 8;
			const spaceAbove = rect.top - 8;
			const placeAbove =
				menuPlacement === "top" ||
				(menuPlacement === "auto" && spaceAbove > spaceBelow);
			const rowHeight = 32;
			const searchHeight = options.length > 5 ? 42 : 0;
			const contentHeight = Math.min(
				options.length * rowHeight + searchHeight,
				400
			);
			const maxH = Math.min(
				contentHeight,
				placeAbove ? spaceAbove : spaceBelow,
				400
			);
			setPos({
				top: placeAbove ? Math.max(8, rect.top - maxH - 4) : rect.bottom + 4,
				left: rect.left,
				width: Math.max(rect.width, minWidth),
				maxH,
				placement: placeAbove ? "top" : "bottom",
			});
			setSearch("");
			setTimeout(() => searchRef.current?.focus(), 0);
		}
		setOpen(!open);
	};
	const selected = options.find((o) => o.id === value);
	const showSearch = options.length > 5;
	const filtered = search
		? options.filter(
				(o) =>
					o.label.toLowerCase().includes(search.toLowerCase()) ||
					o.detail?.toLowerCase().includes(search.toLowerCase()) ||
					o.status?.toLowerCase().includes(search.toLowerCase())
			)
		: options;
	const searchBox = showSearch ? (
		<div className="border-b border-inferay-gray-border px-2 py-1.5">
			<input
				ref={searchRef}
				type="text"
				value={search}
				onChange={(e) => setSearch(e.target.value)}
				placeholder="Search..."
				className="w-full rounded-md border border-inferay-gray-border/50 bg-inferay-dark-gray/50 px-2.5 py-1.5 text-xs text-inferay-white placeholder-inferay-muted-gray outline-none focus:border-inferay-gray-border"
				onKeyDown={(e) => {
					if (e.key === "Escape") {
						setOpen(false);
					}
				}}
			/>
		</div>
	) : null;
	const optionsBox = (
		<div
			className="overflow-y-auto"
			style={{ maxHeight: pos.maxH - (showSearch ? 42 : 2) }}
		>
			{filtered.length === 0 ? (
				<p className="px-3 py-4 text-center text-xs text-inferay-muted-gray">
					{search ? "No matches" : emptyLabel}
				</p>
			) : (
				filtered.map((opt) =>
					renderOption ? (
						<DropdownCustomOption
							key={opt.id}
							opt={opt}
							isSelected={opt.id === value}
							renderOption={renderOption}
							onChange={onChange}
							setOpen={setOpen}
						/>
					) : (
						<button
							type="button"
							key={opt.id}
							onClick={() => {
								onChange(opt.id);
								setOpen(false);
							}}
							className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${
								opt.id === value
									? "bg-inferay-white/[0.08] text-inferay-white"
									: "text-inferay-muted-gray hover:bg-inferay-white/[0.06] hover:text-inferay-white"
							}`}
						>
							{opt.icon && (
								<span className="shrink-0 text-inferay-muted-gray">
									{opt.icon}
								</span>
							)}
							<div>
								<span className="font-medium">{opt.label}</span>
								{opt.detail && (
									<span
										className={`ml-2 rounded-md px-1.5 py-0.5 text-[9px] font-medium ${
											opt.detail.includes("★")
												? "bg-inferay-white/[0.08] text-inferay-soft-white"
												: opt.detail.includes("Best")
													? "bg-inferay-white/[0.08] text-inferay-soft-white"
													: "bg-inferay-white/[0.06] text-inferay-muted-gray"
										}`}
									>
										{opt.detail}
									</span>
								)}
								{opt.status && (
									<span className="ml-2 text-[10px] text-inferay-muted-gray">
										{opt.status}
									</span>
								)}
							</div>
						</button>
					)
				)
			)}
		</div>
	);
	return (
		<>
			<button
				type="button"
				ref={btnRef}
				onClick={toggle}
				className={`flex items-center gap-2 text-xs transition-colors ${
					fullWidth ? "w-full" : ""
				} ${
					buttonClassName
						? buttonClassName
						: `h-7 rounded-lg border px-3 ${
								open
									? "border-inferay-accent/40 bg-inferay-white/[0.08] text-inferay-white"
									: "border-inferay-gray-border bg-inferay-dark-gray hover:border-inferay-gray-border text-inferay-soft-white"
							}`
				}`}
			>
				{icon}
				<span
					className={`${fullWidth ? "flex-1 truncate text-left" : ""} ${selected ? "text-inferay-white" : "text-inferay-muted-gray"} ${labelClassName}`}
				>
					{selected?.label || placeholder}
				</span>
				<IconChevronDown
					size={10}
					className={`shrink-0 text-inferay-muted-gray transition-transform ${open ? "rotate-180" : ""}`}
				/>
			</button>
			{open &&
				createPortal(
					<div
						ref={menuRef}
						className="fixed z-50 rounded-lg border border-inferay-gray-border bg-inferay-dark-gray/95 shadow-2xl backdrop-blur-xl overflow-hidden"
						style={{
							top: pos.top,
							left: pos.left,
							minWidth: pos.width,
							maxHeight: pos.maxH,
						}}
					>
						{pos.placement === "top" ? (
							<>
								{optionsBox}
								{searchBox && (
									<div className="border-t border-inferay-gray-border">
										{searchBox}
									</div>
								)}
							</>
						) : (
							<>
								{searchBox}
								{optionsBox}
							</>
						)}
					</div>,
					document.body
				)}
		</>
	);
}
