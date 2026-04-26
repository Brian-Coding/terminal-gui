import type { ButtonHTMLAttributes } from "react";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	variant?: "ghost" | "danger" | "subtle";
	size?: "xs" | "sm" | "md";
}

export function IconButton({
	variant = "ghost",
	size = "sm",
	className = "",
	children,
	...props
}: IconButtonProps) {
	const base =
		"inline-flex items-center justify-center rounded-md transition-all disabled:opacity-40 disabled:pointer-events-none";
	const sizes = { xs: "p-0.5", sm: "p-1", md: "p-1.5" };
	const variants = {
		ghost:
			"text-inferay-muted-gray hover:text-inferay-soft-white hover:bg-inferay-white/[0.06]",
		danger: "text-inferay-muted-gray hover:text-red-400 hover:bg-red-500/10",
		subtle: "text-inferay-muted-gray hover:text-inferay-soft-white",
	};
	return (
		<button
			className={`${base} ${sizes[size]} ${variants[variant]} ${className}`}
			{...props}
		>
			{children}
		</button>
	);
}
